import React from 'react'
import { createRoot } from 'react-dom/client'

import TakramAtmosphereOcean from '@three-geospatial/ocean-ifft/components/TakramAtmosphereOcean'
import GlobeOceanProto from '@three-geospatial/ocean-ifft/components/GlobeOceanProto'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element not found')
}

const root = createRoot(rootElement)
const view = new URLSearchParams(window.location.search).get('view')
const Demo = view === 'globe' ? GlobeOceanProto : TakramAtmosphereOcean

root.render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>
)
