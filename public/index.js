


(function () {

    
})();

document.addEventListener('DOMContentLoaded', async () => {
    const regionSelect = document.getElementById("region");
    const bboxInputs = document.querySelectorAll("#bboxMinLon, #bboxMinLat, #bboxMaxLon, #bboxMaxLat");
    const tileInputs = document.querySelectorAll("#tileX, #tileY, #tileZ");

    function updateInputs() {
        const type = document.querySelector('input[name="inputType"]:checked').value;

        regionSelect.disabled = (type !== "region");
        bboxInputs.forEach(i => i.disabled = (type !== "bbox"));
        tileInputs.forEach(i => i.disabled = (type !== "tile"));
    }

    // Attach listeners
    document.querySelectorAll('input[name="inputType"]').forEach(r => {
        r.addEventListener("change", updateInputs);
    });

    updateInputs(); // initial load

    if (!regionSelect) return;

    try {
        const resp = await fetch('/signalk/v2/api/resources/regions');
        if (!resp.ok) throw new Error(`Failed to fetch regions: ${resp.status}`);
        const data = await resp.json();
        // clear existing options
        regionSelect.innerHTML = '';

        const entries = Object.entries(data || {});
        entries
            .sort(([, a], [, b]) => {
                const na = (a && a.name) ? String(a.name) : '';
                const nb = (b && b.name) ? String(b.name) : '';
                return na.localeCompare(nb);
            })
            .forEach(([id, info]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = (info && info.name) ? info.name : id;
                regionSelect.appendChild(opt);

            });

        // if no regions returned, add a fallback option
        if (!regionSelect.options.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '-- No regions available --';
            regionSelect.appendChild(opt);
        }
    } catch (err) {
        console.error('Error loading regions:', err);
    }

    //Fetch available maps and populate the chart select box
    const chartSelect = document.getElementById('chart');
    if (!chartSelect) return;

    try {
        const resp = await fetch('/signalk/v2/api/resources/charts');
        if (!resp.ok) throw new Error(`Failed to fetch charts: ${resp.status}`);
        const data = await resp.json();
        // clear existing options
        chartSelect.innerHTML = '';

        const entries = Object.entries(data || {});
        entries
            .sort(([, a], [, b]) => {
                const na = (a && a.name) ? String(a.name) : '';
                const nb = (b && b.name) ? String(b.name) : '';
                return na.localeCompare(nb);
            })
            .forEach(([id, info]) => {

                if (info.proxy === true) {
                    const opt = document.createElement('option');
                    opt.value = id;
                    opt.textContent = (info && info.name) ? info.name : id;
                    chartSelect.appendChild(opt);
                }
            });

        // if no maps returned, add a fallback option
        if (!chartSelect.options.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '-- No maps available --';
            chartSelect.appendChild(opt);
        }
    } catch (err) {
        console.error('Error loading maps:', err);
    }

    document.getElementById('createJobButton').addEventListener('click', async () => {
        try {
            const chart = document.getElementById('chart').value;
            const regionGUID = document.getElementById('region').value;
            const maxZoom = document.getElementById('maxZoom').value;
            const bbox = {
                minLon: parseFloat(document.getElementById('bboxMinLon').value),
                minLat: parseFloat(document.getElementById('bboxMinLat').value),
                maxLon: parseFloat(document.getElementById('bboxMaxLon').value),
                maxLat: parseFloat(document.getElementById('bboxMaxLat').value)
            };
            // const tile = {
            //     z: parseInt(document.getElementById('tileZ').value),
            //     x: parseInt(document.getElementById('tileX').value),
            //     y: parseInt(document.getElementById('tileY').value),
                
            // };
            // console.log(tile);
            const type = document.querySelector('input[name="inputType"]:checked').value;
            const body = {};
            if (type === 'region') {
                body.regionGUID = regionGUID;
            } else if (type === 'bbox') {
                body.bbox = bbox;
            } 
            // else if (type === 'tile') {
            //     body.tile = tile;
            // }
            body.maxZoom = maxZoom;
            const resp = await fetch(`/signalk/chart-tiles/cache/${chart}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error(`Failed to seed charts: ${resp.status}`);
            const data = await resp.json();
        } catch (err) {
            console.error('Error seeding charts:', err);
        }
    });

    const fmt = n => (typeof n === 'number' ? n.toLocaleString() : '-');
    const statusText = s => {
        switch (s) {
            case 0: return 'Stopped';
            case 1: return 'Running';
            default: return String(s);
        }
    };

    function renderJobs(items) {
        const tbody = document.querySelector('#activeJobsTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!Array.isArray(items) || items.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="10" class="muted">No active jobs</td>';
            tbody.appendChild(tr);
            return;
        }

        items.forEach((it, idx) => {
            const tr = document.createElement('tr');

            const pct = (typeof it.progress === 'number' && isFinite(it.progress)) ? Math.max(0, Math.min(100, it.progress * 100)) : 0;
            const pctText = `${pct.toFixed(1)}%`;
            tr.innerHTML = [
                `<td>${idx + 1}</td>`,
                `<td>${it.chartName || '-'}</td>`,
                `<td>${it.regionName || '-'}</td>`,
                `<td>${fmt(it.totalTiles)}</td>`,
                `<td>${fmt(it.downloadedTiles)}</td>`,
                `<td>${fmt(it.cachedTiles)}</td>`,
                `<td>${fmt(it.failedTiles)}</td>`,
                `<td>
                         <span class="progress-bar" aria-hidden="true">
                             <span class="progress-fill" style="width:${pct}%"></span>
                         </span>
                         <span class="percent">${pctText}</span>
                     </td>`,
                `<td>${statusText(it.status)}</td>`,
                `
                <td class="action-buttons">
                    <button class="btn startstop-btn" data-id="${it.id}" data-totalTiles="${it.totalTiles}" title="Start">
                        <svg class="icon-play ${it.status === 1 ? "hidden" : ""}" viewBox="0 0 24 24" width="16" height="16" fill="white">
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                        <svg class="icon-pause ${it.status === 1 ? "" : "hidden"}" viewBox="0 0 24 24" width="16" height="16" fill="white">
                            <path d="M6 19h4V5H6zm8-14v14h4V5z"/>
                        </svg>
                    </button>
                    <button class="btn delete-btn" data-id="${it.id}" title="Delete">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="white">
                            <path d="M3 6h18v2H3zm3 3h12v12H6zM8 2h8v2H8z"/>
                        </svg>
                    </button>
                    <button class="btn remove-btn" data-id="${it.id}" title="Remove">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="white">
                            <path d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.3 10.59 10.6l6.3-6.3z"/>
                        </svg>
                    </button>
                </td>
                    `
            ].join('');

            tr.querySelectorAll('.startstop-btn').forEach(button => {
                button.addEventListener('click', () => {
                    const playIcon = button.querySelector('.icon-play');
                    const pauseIcon = button.querySelector('.icon-pause');
                    const jobId = button.getAttribute('data-id');
                    const totalTiles = button.getAttribute('data-totalTiles');
                    const isRunning = pauseIcon.classList.contains('hidden');
                    console.log(isRunning)
                    if (isRunning) {
                        // Switch to stop
                        if (totalTiles > 100000 && !confirm(`This job has more than ${totalTiles} tiles to download. Starting it may take a long time and put high load on the server. Are you sure you want to start it?`)) {
                            return;
                        }
                        takeAction(jobId, 'start');
                        button.title = 'Stop';
                    } else {
                        // Switch to start
                        takeAction(jobId, 'stop');
                        button.title = 'Start';
                    }
                });
            });

            tr.querySelectorAll('.delete-btn').forEach(button => {
                button.addEventListener('click', () => {
                    if (confirm("This will delete all cached tiles for this job. Are you sure?")) {
                        const jobId = button.getAttribute('data-id');
                        if (jobId) {
                            takeAction(jobId, 'delete');
                        }
                    }
                });
            });

            tr.querySelectorAll('.remove-btn').forEach(button => {
                button.addEventListener('click', () => {
                    const jobId = button.getAttribute('data-id');
                    if (jobId) {
                        takeAction(jobId, 'remove');
                    }
                });
            });

            tbody.appendChild(tr);
        });



        function takeAction(jobId, action) {
            fetch(`/signalk/chart-tiles/cache/jobs/${jobId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: action,
                })
            })
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Failed to ${action} job ${jobId}: ${response.status}`);
                    }
                    fetchActiveJobs();
                })
                .catch(error => {
                    console.error(`Error ${action} job:`, error);
                });
        }
    }



    async function fetchActiveJobs() {
        const tbody = document.querySelector('#activeJobsTable tbody');
        try {
            const resp = await fetch('/signalk/chart-tiles/cache/jobs');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            renderJobs(data);
        } catch (err) {
            console.error('Error fetching active jobs:', err);
            tbody.innerHTML = '<tr><td colspan="10" class="muted">Error loading active jobs</td></tr>';
        }
    }



    fetchActiveJobs();
    // refresh every 2 seconds
    setInterval(fetchActiveJobs, 2000);


});

