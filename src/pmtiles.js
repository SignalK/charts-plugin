const pmtiles = require('pmtiles')
const _ = require('lodash')

async function openPMTilesFile(baseDir, filename, port = 3000) {
    const pluginApiPath = '/plugins/charts/pmtiles/'
    const pmPath = `http://localhost:${port}${pluginApiPath}${filename}`
    const pmt = new pmtiles.PMTiles(pmPath)
    const pMap = {
        _fileFormat: 'pmtiles',
        _filePath: `${baseDir}/${filename}`,
        _pmtilesHandle: pmt,
        _flipY: false,
        identifier: filename,
        name: filename,
        description: '',
        type: 'tilelayer',
        scale: 250000,
        v1: {
            tilemapUrl: `${pluginApiPath}${filename}`,
            chartLayers: []
        },
        v2: {
            url: `${pluginApiPath}${filename}`,
            layers: []
        }
        /* Filled by getMetadata()
        bounds: 
        minzoom:
        maxzoom: 
        format:
        layers: */
    }
    return pMap
}

async function getMetadata(chartProviders) {
    _.forOwn(chartProviders, async (provider) => {
        if (provider._pmtilesHandle) {
            const header = await provider._pmtilesHandle.getHeader()
            const metaData = await provider._pmtilesHandle.getMetadata()
            const {minZoom, maxZoom, tileType, minLon,minLat,maxLon,maxLat} = header
            provider.minzoom = minZoom
            provider.maxzoom = maxZoom
            provider.bounds = [minLon, minLat, maxLon, maxLat]
            provider.format = tileType === 1 ? 'mvt' : tileType === 2 ? 'png' : tileType === 3 ? 'jpg' : tileType === 4 ? 'webp' : 'unknown'
            provider.v1.chartLayers =  metaData.vector_layers 
                ? metaData.vector_layers.map( l=> l.id )
                : []
            provider.v2.layers =  provider.v1.chartLayers.map( l=> l )
        }
    })
}

module.exports = {
    openPMTilesFile,
    getMetadata
}
