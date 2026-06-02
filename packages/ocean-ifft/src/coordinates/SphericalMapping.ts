import * as THREE from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

export interface GeographicBounds {
  lonLeft: number
  lonRight: number
  latTop: number
  latBottom: number
}

export interface TileCoordinates {
  x: number
  y: number
  z: number // zoom level
}

export class SphericalMapping {
  static readonly EARTH_RADIUS = 6371000 // meters
  static readonly OCEAN_RADIUS = 6371001 // Earth radius + 1m offset

  /**
   * Convert tile coordinates to geographic bounds using Web Mercator projection
   * Same projection as Google 3D tiles for consistency
   */
  static tileToGeographicBounds(x: number, y: number, z: number): GeographicBounds {
    const n = Math.pow(2, z)
    
    // Convert tile coordinates to longitude
    const lonLeft = (x / n) * 360 - 180
    const lonRight = ((x + 1) / n) * 360 - 180
    
    // Convert tile coordinates to latitude using inverse Web Mercator
    const latTop = this.tile2lat(y, z)
    const latBottom = this.tile2lat(y + 1, z)
    
    return { lonLeft, lonRight, latTop, latBottom }
  }

  /**
   * Convert tile Y coordinate to latitude (inverse Web Mercator)
   */
  private static tile2lat(y: number, z: number): number {
    const n = Math.pow(2, z)
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)))
    return latRad * 180 / Math.PI
  }

  /**
   * Convert geographic coordinates to tile coordinates
   */
  static geographicToTile(longitude: number, latitude: number, zoom: number): TileCoordinates {
    const n = Math.pow(2, zoom)
    const x = Math.floor((longitude + 180) / 360 * n)
    
    // Web Mercator projection for Y
    const latRad = latitude * Math.PI / 180
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n)
    
    return { x, y, z: zoom }
  }

  /**
   * Create spherical quad geometry for a tile
   */
  static createSphericalTileGeometry(
    bounds: GeographicBounds, 
    resolution: number = 32,
    radius: number = SphericalMapping.OCEAN_RADIUS
  ): THREE.BufferGeometry {
    const positions: number[] = []
    const indices: number[] = []
    const uvs: number[] = []
    const normals: number[] = []

    // Generate grid points on sphere surface
    for (let i = 0; i <= resolution; i++) {
      for (let j = 0; j <= resolution; j++) {
        const u = i / resolution
        const v = j / resolution
        
        // Interpolate within tile bounds
        const lon = bounds.lonLeft + (bounds.lonRight - bounds.lonLeft) * u
        const lat = bounds.latTop + (bounds.latBottom - bounds.latTop) * v
        
        // Convert to sphere surface position
        const lonRad = lon * Math.PI / 180
        const latRad = lat * Math.PI / 180
        
        // Spherical to Cartesian conversion (Y-up coordinate system like Three.js)
        const x = radius * Math.cos(latRad) * Math.cos(lonRad)
        const y = radius * Math.sin(latRad)  
        const z = radius * Math.cos(latRad) * Math.sin(lonRad)
        
        positions.push(x, y, z)
        uvs.push(u, v)
        
        // Normal points outward from sphere center
        const normal = new THREE.Vector3(x, y, z).normalize()
        normals.push(normal.x, normal.y, normal.z)
      }
    }
    
    // Generate triangle indices
    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const a = i * (resolution + 1) + j
        const b = a + 1
        const c = (i + 1) * (resolution + 1) + j
        const d = c + 1
        
        // Two triangles per quad
        indices.push(a, b, c)
        indices.push(b, d, c)
      }
    }
    
    const geometry = new THREE.BufferGeometry()
    geometry.setIndex(indices)
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    
    return geometry
  }

  /**
   * Convert flat ocean chunk offset to spherical tile coordinates
   * This maintains existing LOD behavior from the quadtree system
   */
  static offsetToTileCoords(
    offset: THREE.Vector3, 
    lod: number, 
    tileSize: number = 1000,
    worldCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): TileCoordinates {
    // Convert world offset to normalized coordinates first
    // Assuming ocean quadtree spans from -ocean_size to +ocean_size
    const OCEAN_SIZE = 500000 // Should match ocean_constants.OCEAN_SIZE
    
    // Normalize to 0-1 range  
    const normalizedX = (offset.x + OCEAN_SIZE) / (2 * OCEAN_SIZE)
    const normalizedZ = (offset.z + OCEAN_SIZE) / (2 * OCEAN_SIZE)
    
    // Convert to tile coordinates at the given zoom level
    const tilesPerAxis = Math.pow(2, Math.max(0, lod))
    const x = Math.floor(normalizedX * tilesPerAxis)
    const y = Math.floor(normalizedZ * tilesPerAxis)
    
    return { x, y, z: Math.max(0, lod) }
  }

  /**
   * Convert world position to geographic UV coordinates (0-1 range)
   * Used for sampling Sebastian Lague's global mask textures
   */
  static worldToGeographicUV(worldPos: THREE.Vector3): THREE.Vector2 {
    // Convert Cartesian to geographic
    const r = worldPos.length()
    const lat = Math.asin(worldPos.y / r) 
    const lon = Math.atan2(worldPos.z, worldPos.x)
    
    // Map longitude [-π, π] to U [0, 1]
    const u = (lon + Math.PI) / (2 * Math.PI)
    
    // Map latitude [-π/2, π/2] to V [0, 1] (flipped for texture coordinates)
    const v = 1.0 - (lat + Math.PI/2) / Math.PI
    
    return new THREE.Vector2(u, v)
  }

  /**
   * Calculate distance between two geographic points (in meters)
   * Useful for LOD calculations
   */
  static geographicDistance(
    lon1: number, lat1: number,
    lon2: number, lat2: number
  ): number {
    const R = this.EARTH_RADIUS
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
    return R * c
  }
}