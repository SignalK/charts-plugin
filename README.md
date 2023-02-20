# Signal K Node server Charts plugin

Signal K Node server plugin to provide chart metadata, such as name, description and location of the actual chart tile data.

### Usage

1. Install "Signal K Charts" plugin from Signal K Appstore

2. Configure plugin in **Plugin Config** 

- Add "Chart paths" which are the paths to the folders where chart files are stored. Defaults to `${signalk-configuration-path}/charts`

- Set the version of Signal K API to use. _(Default: **0**)_

    0. `(default)` : Signal K server major version is used to determine the API version to use. (_See examples below.)_

    1. `v1` : path = /signalk/`v1`/api/resources/charts`

    2. `v2` : path = /signalk/`v2`/api/resources/charts.
    
    The selection you make will be determined by your chart plotter software.

    _Examples: When selection is **0 (auto detect)**:_
```
    '1.42.0' => 'v1'
    `2.0.0` => 'v2'
```


3. Add "Chart paths" in plugin configuration. Defaults to `${signalk-configuration-path}/charts`

<img src="https://user-images.githubusercontent.com/38519157/168979985-1eb4a940-7b1d-4800-a3b7-4acc7c00162e.png" alt="Chart paths configuration" width="450"/>

4. Put charts into selected paths

5. Add optional online chart providers

<img src="https://user-images.githubusercontent.com/1435910/45048136-c65d2e80-b083-11e8-99db-01e8cece9f89.png" alt="Online chart providers configuration" width="450"/>

_WMS example:_
![image](https://user-images.githubusercontent.com/38519157/102832518-90077100-443e-11eb-9a1d-d0806bb2b10b.png)

6. Activate plugin

7. Use one of the client apps supporting Signal K charts, for example:
- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk)
- [Tuktuk Chart Plotter](https://www.npmjs.com/package/tuktuk-chart-plotter)

### Supported chart formats

- [MBTiles](https://github.com/mapbox/mbtiles-spec) file
- Directory with cached [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification) tiles and `tilemapresource.xml`
- Directory with XYZ tiles and `metadata.json`
- Online [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification)

Publicly available MBTiles charts can be found from:
- [NOAA Nautical charts](https://distribution.charts.noaa.gov/ncds/index.html)
- [Finnish Transport Agency nautical charts](https://github.com/vokkim/rannikkokartat-mbtiles)
- [Signal K World Coastline Map](https://github.com/netAction/signalk-world-coastline-map), download [MBTiles release](https://github.com/netAction/signalk-world-coastline-map/releases/download/v1.0/signalk-world-coastline-map-database.tgz)

### API

Plugin adds support for `/resources/charts` endpoints described in [Signal K specification](http://signalk.org/specification/1.0.0/doc/otherBranches.html#resourcescharts):

- `GET /signalk/v1/api/resources/charts/` returns metadata for all available charts
- `GET /signalk/v1/api/resources/charts/${identifier}/` returns metadata for selected chart
- `GET /signalk/v1/api/resources/charts/${identifier}/${z}/${x}/${y}` returns a single tile for selected offline chart. As charts-plugin isn't proxy, online charts is not available via this request. You should look the metadata to find proper request.

License
-------
Copyright 2018 Mikko Vesikkala

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
