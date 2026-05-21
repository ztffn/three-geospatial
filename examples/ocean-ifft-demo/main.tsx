import React from 'react'
import { createRoot } from 'react-dom/client'

import GlobeOceanProto from '@three-geospatial/ocean-ifft/components/GlobeOceanProto'

const rootElement = document.getElementById('root')

if (rootElement == null) {
  throw new Error('Root element not found')
}

const root = createRoot(rootElement)

root.render(
  <React.StrictMode>
    <GlobeOceanProto />
  </React.StrictMode>
)
