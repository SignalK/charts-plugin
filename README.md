# Signal K Node server Charts plugin

Signal K Node server plugin to provide chart metadata, such as name, description and location of the actual chart tile data.

### Usage

1. Install "Signal K Charts" plugin from Signal K Appstore

2. Add "Chart paths" in plugin configuration. Defaults to `${signalk-configuration-path}/charts`

![Configuration options](https://user-images.githubusercontent.com/1435910/39382493-57c1e4dc-4a6e-11e8-93e1-cedb4c7662f4.png)

3. Put charts into selected paths

4. Activate plugin

5. Use one of the client apps supporting Signal K charts, for example:
- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk)
- [Tuktuk Chart Plotter](https://www.npmjs.com/package/tuktuk-chart-plotter)

### Supported chart formats

- [MBTiles](https://github.com/mapbox/mbtiles-spec) file
- Directory with cached [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification) tiles and `tilemapresource.xml`
- Directory with XYZ tiles and `metadata.json`

Publicly available MBTiles charts can be found from:
- [NOAA Nautical charts](http://tileservice.charts.noaa.gov/), quick download [cheat-sheet](https://github.com/vokkim/noaa-nautical-charts)
- [Finnish Transport Agency nautical charts](https://github.com/vokkim/rannikkokartat-mbtiles)
- [Signal K World Coastline Map](https://github.com/netAction/signalk-world-coastline-map), download [MBTiles release](https://github.com/netAction/signalk-world-coastline-map/releases/download/v1.0/signalk-world-coastline-map-database.tgz)

### API

Plugin adds support for `/resources/charts` endpoints described in [Signal K specification](http://signalk.org/specification/1.0.0/doc/otherBranches.html#resourcescharts):

- `GET /signalk/v1/api/resources/charts/` returns metadata for all available charts
- `GET /signalk/v1/api/resources/charts/${identifier}/` returns metadata for selected chart
- `GET /signalk/v1/api/resources/charts/${identifier}/${z}/${x}/${y}` returns a single tile for selected chart

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