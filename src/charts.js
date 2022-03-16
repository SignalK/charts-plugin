const debug = require('debug')('signalk-charts-plugin')
const Promise = require('bluebird')
const path = require('path')
const MBTiles = require('@mapbox/mbtiles')
const xml2js = require('xml2js')
const fs = Promise.promisifyAll(require('fs'))
const _ = require('lodash')
const {apiRoutePrefix} = require('./constants')

let tilePathPrefix = apiRoutePrefix[1]

function findCharts(chartBaseDir, apiPath) {
  tilePathPrefix = apiPath ? apiPath : apiRoutePrefix[1]
  return fs
    .readdirAsync(chartBaseDir)
    .then(files => {
      return Promise.mapSeries(files, filename => {
        const isMbtilesFile = filename.match(/\.mbtiles$/i)
        const file = path.resolve(chartBaseDir, filename)
        const isDirectory = fs.statSync(file).isDirectory()
        if (isMbtilesFile) {
          return openMbtilesFile(file, filename)
        } else if (isDirectory) {
          return directoryToMapInfo(file, filename)
        } else {
          return Promise.resolve(null)
        }
      })
    })
    .then(result => _.filter(result, _.identity))
    .then(charts => _.reduce(charts, (result, chart) => {
      result[chart.identifier] = chart
      return result
    }, {}))
    .catch(err => {
      console.error(`Error reading charts directory ${chartBaseDir}:${err.message}`)
    })
}

function openMbtilesFile(file, filename) {
  return new Promise((resolve, reject) => {
    new MBTiles(file, (err, mbtiles) => {
      if (err) {
        return reject(err)
      }
      mbtiles.getInfo((err, metadata) => {
        if (err) {
          return reject(err)
        }

        return resolve({mbtiles, metadata})
      })
    })
  }).then(({mbtiles, metadata}) => {
    if (_.isEmpty(metadata) || metadata.bounds === undefined) {
      return null
    }
    const identifier = filename.replace(/\.mbtiles$/i, '')
    return {
      _fileFormat: 'mbtiles',
      _mbtilesHandle: mbtiles,
      _flipY: false,
      identifier,
      name: metadata.name || metadata.id,
      description: metadata.description,
      bounds: metadata.bounds,
      minzoom: metadata.minzoom,
      maxzoom: metadata.maxzoom,
      format: metadata.format,
      type: 'tilelayer',
      tilemapUrl: `${tilePathPrefix}/charts/${identifier}/{z}/{x}/{y}`,
      scale: metadata.scale || '250000'
    }
  }).catch(e => {
    console.error(`Error loading chart ${file}`, e.message)
    return null
  })
}

function parseTilemapResource(tilemapResource) {
   return fs
    .readFileAsync(tilemapResource)
    .then(Promise.promisify(xml2js.parseString))
    .then(parsed => {
      const result = parsed.TileMap
      const name = _.get(result, 'Title.0')
      const format = _.get(result, 'TileFormat.0.$.extension')
      const scale = _.get(result, 'Metadata.0.$.scale')
      const bbox = _.get(result, 'BoundingBox.0.$')
      const zoomLevels = _.map(_.get(result, 'TileSets.0.TileSet')||[], set => parseInt(_.get(set, '$.href')))
      return {
        _flipY: true,
        name,
        description: name,
        bounds: bbox ? [parseFloat(bbox.minx), parseFloat(bbox.miny), parseFloat(bbox.maxx), parseFloat(bbox.maxy)] : undefined,
        minzoom: !_.isEmpty(zoomLevels) ? _.min(zoomLevels) : undefined,
        maxzoom: !_.isEmpty(zoomLevels) ? _.max(zoomLevels) : undefined,
        format,
        type: 'tilelayer',
        scale: scale || '250000'
      }
    })
}

function parseMetadataJson(metadataJson) {
   return fs
    .readFileAsync(metadataJson)
    .then(JSON.parse)
    .then(metadata => {
      function parseBounds(bounds) {
        if (_.isString(bounds)) {
          return _.map(bounds.split(','), bound => parseFloat(_.trim(bound)))
        } else if (_.isArray(bounds) && bounds.length === 4) {
          return bounds
        } else {
          return undefined
        }
      }
      return {
        _flipY: false,
        name: metadata.name || metadata.id,
        description: metadata.description,
        bounds: parseBounds(metadata.bounds),
        minzoom: parseIntIfNotUndefined(metadata.minzoom),
        maxzoom: parseIntIfNotUndefined(metadata.maxzoom),
        format: metadata.format,
        type: 'tilelayer',
        scale: metadata.scale || '250000'
      }
    })
}

function directoryToMapInfo(file, identifier) {
  function loadInfo() {
    const tilemapResource = path.join(file, 'tilemapresource.xml')
    const metadataJson = path.join(file, 'metadata.json')

    const hasTilemapResource = fs.existsSync(tilemapResource)
    const hasMetadataJson = fs.existsSync(metadataJson)
    if (hasTilemapResource) {
      return parseTilemapResource(tilemapResource)
    } else if (hasMetadataJson) {
      return parseMetadataJson(metadataJson)
    } else {
      return Promise.resolve(null)
    }
  }

  return loadInfo()
    .then(info => {
      if (info) {
        if (!info.format) {
          console.error(`Missing format metadata for chart ${identifier}`)
          return null
        }
        return _.merge(info, {
          identifier,
          _fileFormat: 'directory',
          _filePath: file,
          tilemapUrl: `${tilePathPrefix}/charts/${identifier}/{z}/{x}/{y}`,
        })
      }
      return null
    })
    .catch(e => {
      console.error(`Error getting charts from ${file}`, e.message)
      return undefined
    })
}

function parseIntIfNotUndefined(val) {
  const parsed = parseInt(val)
  return _.isFinite(parsed) ? parsed : undefined
}

module.exports = {
  findCharts
}
