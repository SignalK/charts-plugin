var map
var settings
var layerControl
var drawnItems
var activeRegionLayer = null
var isDeleting = false
let jobsPollInterval = null
let jobsControl = null

document.addEventListener('DOMContentLoaded', async () => {
  await setupCharts()

  setupRegions()
})

function normalizeLng(lng) {
  let v = Number(lng)
  if (!isFinite(v)) return v
  while (v < -360) v += 360
  while (v > 360) v -= 360
  return v
}

function normalizePolygon(layer) {
  const latlngs = layer.getLatLngs()

  latlngs[0].forEach((ll) => {
    ll.lng = normalizeLng(ll.lng)
  })

  layer.setLatLngs(latlngs)
}

function saveSettings()
{
  localStorage.setItem('settings', JSON.stringify(settings))
}

async function setupCharts() {
  settings = JSON.parse(localStorage.getItem("settings") || "{}");

  settings.map = settings.map || { center: [0, 0], zoomLevel: 3 };
  settings.selections = settings.selections || { charts: [] };
  settings.selections.charts = settings.selections.charts || [];
  console.log(settings)

  map = L.map('map').setView(
      settings ? settings.map.center : [0, 0],
      settings ? settings.map.zoomLevel : 8
  );

  map.on('moveend', function () {
    const center = map.getCenter();
    const zoom = map.getZoom();
    settings.map = {
        center: [center.lat, center.lng],
        zoomLevel: zoom
      }
    saveSettings();
  });

  // Layer to store drawn shapes
  drawnItems = new L.FeatureGroup()
  map.addLayer(drawnItems)

  // Add draw controls
  const drawControl = new L.Control.Draw({
    position: 'topleft',
    edit: {
      featureGroup: drawnItems
    },
    draw: {
      polygon: {
        allowIntersection: false, // Restricts shapes to simple polygons
        drawError: {
          color: '#e1e100', // Color the shape will turn when intersects
          message: "<strong>Oh snap!<strong> you can't draw that!" // Message that will show when intersect
        },
        shapeOptions: {
          color: '#97009c'
        }
      },
      polygon: true,
      polyline: false,
      rectangle: true,
      circle: false,
      marker: false,
      circlemarker: false
    }
  })

  map.on(L.Draw.Event.DELETESTART, () => {
    isDeleting = true
  })

  map.on(L.Draw.Event.DELETESTOP, () => {
    isDeleting = false
  })

  map.addControl(drawControl)

  jobsControl = L.control({ position: 'topright' })

  jobsControl.onAdd = function () {
    const btn = L.DomUtil.create(
      'button',
      'leaflet-bar leaflet-control leaflet-control-custom leaflet-control-button leaflet-button'
    )
    btn.innerHTML = '<img src="leaflet/images/downloads.png" alt="Active seeding jobs" style="width:16px;height:16px;">'

     // Create badge
    const badge = L.DomUtil.create('span', 'jobs-badge', btn)
    badge.innerText = '0' // initial value
    // Prevent map drag when clicking
    L.DomEvent.disableClickPropagation(btn)

    btn.onclick = toggleJobsModal
    // Store reference so we can update it later
    jobsControl._badge = badge
    updateJobsBadge(0) // hide badge initially
    return btn
  }
  jobsControl.addTo(map)

  const helpControl = L.control({ position: 'bottomright' })

  helpControl.onAdd = function () {
    const btn = L.DomUtil.create(
      'button',
      'leaflet-bar leaflet-control leaflet-control-custom leaflet-control-button leaflet-button'
    )
    btn.innerHTML = '<img src="leaflet/images/lifebuoy.png" alt="Help" style="width:16px;height:16px;">'

    // Prevent map drag when clicking
    L.DomEvent.disableClickPropagation(btn)

    btn.onclick = toggleHelpModal
    return btn
  }
  helpControl.addTo(map)

  map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer
    normalizePolygon(layer)
    drawnItems.addLayer(layer)
    layer.feature = {
      type: 'Feature',
      properties: { name: 'Unnamed' }
    }
    layer.on('click', () => {
      if (isDeleting) return
      openRegionModal(layer)
    })
    drawnItems.addLayer(layer)
    openRegionModal(layer)
    saveRegions()
  })
  map.on(L.Draw.Event.EDITED, () => saveRegions())
  map.on(L.Draw.Event.DELETED, () => saveRegions())
  await loadRegions()

  // Create a custom control
  const statusControl = L.control({ position: 'bottomleft' })

  statusControl.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-status-control')
    div.innerHTML = 'Lat: --, Lng: -- | Zoom: --'
    return div
  }

  statusControl.addTo(map)

  map.on('mousemove', function (e) {
    const { lat, lng } = e.latlng
    document.querySelector(
      '.map-status-control'
    ).innerHTML = `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(
      5
    )} | Zoom: ${map.getZoom()}`
  })

  map.on('zoomend', function () {
    const div = document.querySelector('.map-status-control')
    if (div.textContent.includes('Lat')) {
      const zoom = map.getZoom()
      div.innerHTML = div.innerHTML.replace(/Zoom: \d+/, `Zoom: ${zoom}`)
    }
  })

  const chartSelect = document.getElementById('chartSelect')
  if (!chartSelect) return
  // Fetch available charts from SignalK server
  try {
    const resp = await fetch('/signalk/v2/api/resources/charts')
    if (!resp.ok) {
      throw new Error(`Failed to fetch charts: ${resp.status}`)
    }
    const data = await resp.json()
    const entries = Object.entries(data || {})
    overlayMaps = {}
    entries
      .sort(([, a], [, b]) => {
        const na = a && a.name ? String(a.name) : ''
        const nb = b && b.name ? String(b.name) : ''
        return na.localeCompare(nb)
      })
      .forEach(([id, info]) => {
        if (info.proxy === true && info.type === 'tilelayer') {
          const opt = document.createElement('option')
          opt.value = id
          opt.textContent = info && info.name ? info.name : id
          chartSelect.appendChild(opt)

          layer = L.tileLayer(`${info.url}`, {
            maxZoom: info.maxZoom || 19,
            minZoom: info.minZoom || 1,
            checked: settings.selections.charts.includes(info.name)
          })
          layer.addTo(map)
          if (!settings.selections.charts.includes(info.name)){
            map.removeLayer(layer)
          }
          overlayMaps[info.name || id] = layer
        }
      })
    layerControl = L.control
      .layers({}, overlayMaps, {
        position: 'topright'
      })
      .addTo(map)
  } catch (err) {
    console.error('Error loading maps:', err)
  }

  map.on('overlayadd', function (e) {
    const name = e.name;

    if (!settings.selections.charts.includes(name)) {
      settings.selections.charts.push(name);
    }

    saveSettings();
  });

  map.on('overlayremove', function (e) {
    const name = e.name;

    settings.selections.charts =
      settings.selections.charts.filter(c => c !== name);

    saveSettings();
  });

  jobsPollInterval = setInterval(fetchActiveJobs, 2000)
  setupDragAndDrop()
}

// Help

function toggleHelpModal() {
  let modal = document.getElementById('helpModal')
  const isHidden = modal.classList.toggle('hidden')
}

// Jobs

function toggleJobsModal() {
  let modal = document.getElementById('jobsModal')
  const isHidden = modal.classList.toggle('hidden')

  if (isHidden) {
    if (!jobsPollInterval) return

    // clearInterval(jobsPollInterval)
    // jobsPollInterval = null
  } else {
    if (jobsPollInterval) return // already running

    fetchActiveJobs() // fetch immediately
    
  }
}

// function setupJobs() {
//   modal = document.getElementById('jobsModal')
// }

function renderProgress(job) {
  const pct =
    typeof job.progress === 'number' && isFinite(job.progress)
      ? Math.max(0, Math.min(100, job.progress * 100))
      : 0
  const pctText = `${pct.toFixed(1)}%`

  return `
    <span class="progress-bar">
      <span class="progress-fill" style="width:${pct}%"></span>
    </span>
    <span class="percent">${pctText}</span>
  `
}

function cloneTemplate(id) {
  const tpl = document.getElementById(id)
  if (!tpl) {
    console.error(`Template "${id}" not found`)
    return null
  }
  return tpl.content.cloneNode(true)
}

function fillProgress(container, job) {
  const pct =
    typeof job.progress === 'number' && isFinite(job.progress)
      ? Math.max(0, Math.min(100, job.progress * 100))
      : 0
  const pctText = `${pct.toFixed(1)}%`

  container.innerHTML = `
    <span class="progress-bar">
      <span class="progress-fill" style="width:${pct}%"></span>
    </span>
    <span class="percent">${pctText}</span>
  `
}

function createJobCard(job) {
  const frag = cloneTemplate('job-card-template')
  if (!frag) return ''
  const card = frag.querySelector('.job-card')

  card.dataset.id = job.id

  card.querySelector('.job-region').textContent = job.regionName
  card.querySelector('.job-chart').textContent = job.chartName
  card.querySelector('.job-status').textContent = job.status || ''
  card.querySelector('.job-total').textContent = job.totalTiles.toLocaleString()
  if (job.type === 1) {
    card.querySelector('.job-seed').classList.remove('hidden')
    card.querySelector('.job-downloaded').textContent =
      job.downloadedTiles.toLocaleString()
    card.querySelector('.job-cached').textContent =
      job.cachedTiles.toLocaleString()
    card.querySelector('.job-failed').textContent =
      job.failedTiles.toLocaleString()
  } else if (job.type === 2) {
    card.querySelector('.job-delete').classList.remove('hidden')
    card.querySelector('.job-deleted').textContent = job.deletedTiles
      ? job.deletedTiles.toLocaleString()
      : '0'
  }

  card.querySelector('.job-remove').addEventListener('click', () => {
    takeAction(job.id, 'remove')
  })

  // const startStopButton = card.querySelector('.job-startstop button')
  // if (job.state === 1) {
  //   startStopButton.textContent = 'Stop'
  //   startStopButton.title = 'Stop'
  //   startStopButton.classList.add('btn--danger')
  //   startStopButton.addEventListener('click', () => {
  //     takeAction(job.id, 'stop')
  //     fetchActiveJobs()
  //   })
  // } else if (job.state === 0) {
  //   startStopButton.textContent = 'Start'
  //   startStopButton.title = 'Start'
  //   if (job.type === 1) {
  //     startStopButton.addEventListener('click', () => {
  //     takeAction(job.id, 'start')
  //     fetchActiveJobs()
  //   })
  //   } else if (job.type === 2) {
  //     startStopButton.addEventListener('click', () => {
  //     takeAction(job.id, 'delete')
  //     fetchActiveJobs()
  //   })
  //   }

    
  // }

  fillProgress(card.querySelector('.job-card-progress'), job)

  return frag
}

function renderJobs(jobs) {
  const cardContainer = document.getElementById('jobsGrid')

  cardContainer.innerHTML = ''

  if (!Array.isArray(jobs) || jobs.length === 0) {
    document.getElementById('noJobsMessage').classList.remove('hidden')
    return
  }
  document.getElementById('noJobsMessage').classList.add('hidden')
  jobs.forEach((job, index) => {
    cardContainer.appendChild(createJobCard(job))
  })
}

async function fetchActiveJobs() {
  try {
    const resp = await fetch('/signalk/chart-tiles/cache/jobs')
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const data = await resp.json()
    renderJobs(data)
    updateJobsBadge(data.filter(item => item.state === 1).length)
  } catch (err) {
    console.error('Error fetching active jobs:', err)
  }
}

async function createJob(action) {
  try {
    if (activeRegionLayer == null) {
      return
    }
    const chart = document.getElementById('chartSelect').value
    const minZoom = document.getElementById('minZoom').value
    const maxZoom = document.getElementById('maxZoom').value
    const refetch = document.getElementById('refetch').checked
    const mbtiles = document.getElementById('mbtiles').checked
    const vacuum = document.getElementById('vacuum').checked
    const body = {}
    body.minZoom = minZoom
    body.maxZoom = maxZoom
    body.feature = activeRegionLayer.toGeoJSON()
    body.action = action
    body.options = { refetch: refetch, mbtiles: mbtiles, vacuum: vacuum }

    console.log('Creating job with body:', body)
    const resp = await fetch(`/signalk/chart-tiles/cache/${chart}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!resp.ok) {
      //TODO: No reason to throw here
      throw new Error(`Failed to seed charts: ${resp.status}`)
    }
    const data = await resp.json()
    const responseSpan = document.getElementById('response')
    responseSpan.classList.remove('hidden')
    responseSpan.textContent = data.message || 'Success'
    setTimeout(() => {
      responseSpan.textContent = ''
      responseSpan.classList.add('hidden')
    }, 2000)
  } catch (err) {
    console.error('Error seeding charts:', err)
  }
  closeRegionModal()
}

function updateJobsBadge(count) {
  if (!jobsControl._badge) return
  jobsControl._badge.innerText = count
  jobsControl._badge.style.display = count > 0 ? 'flex' : 'none'
}

function takeAction(jobId, action) {
  const serverResponse = document.getElementById('response')
  fetch(`/signalk/chart-tiles/cache/jobs/${jobId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: action
    })
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to ${action} job ${jobId}: ${response.status}`)
      }
      fetchActiveJobs()
    })
    .catch((error) => {
      console.error(`Error ${action} job:`, error)
    })
}

// Regions

function setupRegions() {
  // Region modal form
  document.getElementById('saveRegion').onclick = () => {
    if (!activeRegionLayer) return

    const p = activeRegionLayer.feature.properties
    p.name = regionName.value
    saveRegions()
  }
}

function setupDragAndDrop() {
  const mapEl = map.getContainer()

  // Required so browser allows drops
  mapEl.addEventListener('dragover', (e) => {
    e.preventDefault()
    mapEl.classList.add('map-drag-hover')
  })

  mapEl.addEventListener('dragleave', () => {
    mapEl.classList.remove('map-drag-hover')
  })

  mapEl.addEventListener('drop', async (e) => {
    e.preventDefault()
    mapEl.classList.remove('map-drag-hover')

    const file = e.dataTransfer.files[0]
    if (!file) return

    if (!file.name.endsWith('.geojson') && !file.name.endsWith('.json')) {
      alert('Please drop a valid GeoJSON file.')
      return
    }

    const text = await file.text()

    let geojson
    try {
      geojson = JSON.parse(text)
    } catch (err) {
      alert('Invalid GeoJSON file.')
      return
    }

    importGeoJSON(geojson)
  })
}

function importGeoJSON(geojson) {
  if (!geojson || !geojson.features) {
    alert('Invalid GeoJSON structure.')
    return
  }

  L.geoJSON(geojson, {
    onEachFeature: (feature, layer) => {
      layer.feature = feature
      layer.onclick = () => openRegionModal(layer)
      drawnItems.addLayer(layer)
    }
  })
  saveRegions()
}

async function saveRegions() {
  const geojson = drawnItems.toGeoJSON()
  let data = JSON.stringify(geojson)

  const res = await fetch('/signalk/chart-tiles/cache/regions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data
  })

  if (!res.ok) {
    console.error('Failed to save regions')
    return
  }
}

async function loadRegions() {
  const res = await fetch('/signalk/chart-tiles/cache/regions')
  if (!res.ok) {
    console.error('Failed to load saved drawings')
    return
  }
  const geojson = await res.json()
  drawnItems.clearLayers()
  L.geoJSON(geojson, {
    style: {
      color: '#97009c'
    },
    onEachFeature: (feature, layer) => {
      layer.on('click', () => {
        if (isDeleting) return
        openRegionModal(layer)
      })
      drawnItems.addLayer(layer)
    }
  })
}

function openRegionModal(layer) {
  activeRegionLayer = layer

  const p = layer.feature.properties

  regionName.value = p.name || p.Name || ''
  const regionModal = document.getElementById('regionModal')
  regionModal.classList.remove('hidden')
}

function closeRegionModal() {
  const regionModal = document.getElementById('regionModal')
  regionModal.classList.add('hidden')
  activeRegionLayer = null
}

function toggleHelpModal() {
  let modal = document.getElementById('help')
  const isHidden = modal.classList.toggle('hidden')
}
