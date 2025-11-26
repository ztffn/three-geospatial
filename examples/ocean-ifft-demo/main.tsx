import React from 'react'
import { createRoot } from 'react-dom/client'

import TakramAtmosphereOcean from '@three-geospatial/ocean-ifft/components/TakramAtmosphereOcean'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element not found')
}

const root = createRoot(rootElement)
root.render(
  <React.StrictMode>
    <TakramAtmosphereOcean />
  </React.StrictMode>
)
