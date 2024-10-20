# Signal K server Charts plugin

Signal K Node server plugin to provide chart metadata, such as name, description and location of the actual chart tile data.

Chart metadata is derived from the following supported chart files:
- Mapbox Tiles _(.mbtiles)_
- Mapbox Styles _(.json)_
- TMS _(tilemapresource.xml and tiles)_

Additionally chart metadata can be defined for other chart sources and types _(e.g. WMS, WMTS, S-57 tiles and tilejson)_.

Chart metadata made available to both v1 and v2 Signal K resources api paths.

| Server Version | API | Path |
|--- |--- |--- |
| 1.x.x | v1 | `/signalk/v1/api/resources/charts` |
| 2.x.x | v2 | `/signalk/v2/api/resources/charts` |

    
_Note: v2 resource paths will only be made available on Signal K server >= v2._

### Usage

1. Install "Signal K Charts" plugin from Signal K Appstore

2. Configure plugin in **Plugin Config** 

- Add "Chart paths" which are the paths to the folders where chart files are stored. Defaults to `${signalk-configuration-path}/charts`


3. Add "Chart paths" in plugin configuration. Defaults to `${signalk-configuration-path}/charts`

<img src="https://user-images.githubusercontent.com/1435910/39382493-57c1e4dc-4a6e-11e8-93e1-cedb4c7662f4.png" alt="Chart paths configuration" width="450"/>


4. Put charts into selected paths

5. Add optional online chart providers

<img src="https://user-images.githubusercontent.com/1435910/45048136-c65d2e80-b083-11e8-99db-01e8cece9f89.png" alt="Online chart providers configuration" width="450"/>

6. (Optional): Add Mapbox access token. 
     When provided, the access token will added to the url of Mapbox Styles _e.g. `?access_token=xyz123`_ 

     ![image](https://github.com/user-attachments/assets/b4d4d048-2ab1-4bf1-896b-2ca0031ec77f)


_WMS example:_

<img src="https://user-images.githubusercontent.com/38519157/102832518-90077100-443e-11eb-9a1d-d0806bb2b10b.png" alt="server type configuration" width="450"/>

6. Activate plugin

7. Use one of the client apps supporting Signal K charts, for example:
- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk)
- [Tuktuk Chart Plotter](https://www.npmjs.com/package/tuktuk-chart-plotter)

### Supported chart formats
pk.eyJ1IjoiYWRhbTIyMjIiLCJhIjoiY2l5dGJhaW96MDAwcDJ3bzM0MXk2aTB0bSJ9.kgHNRDiGEmq12toljp2-kA

- [MBTiles](https://github.com/mapbox/mbtiles-spec) file
- [Mapbox Style](https://docs.mapbox.com/help/glossary/style/) JSON file _e.g. `bright-v9.json`_
- Directory with cached [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification) tiles and `tilemapresource.xml`
- Directory with XYZ tiles and `metadata.json`
- Online [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification)

Publicly available MBTiles charts can be found from:
- [NOAA Nautical charts](https://distribution.charts.noaa.gov/ncds/index.html)
- [Finnish Transport Agency nautical charts](https://github.com/vokkim/rannikkokartat-mbtiles)
- [Signal K World Coastline Map](https://github.com/netAction/signalk-world-coastline-map), download [MBTiles release](https://github.com/netAction/signalk-world-coastline-map/releases/download/v1.0/signalk-world-coastline-map-database.tgz)

### API

Plugin adds support for `/resources/charts` endpoints described in [Signal K specification](http://signalk.org/specification/1.0.0/doc/otherBranches.html#resourcescharts):

- Return metadata for all available charts

```bash
# v1 API
GET /signalk/v1/api/resources/charts/` 

# v2 API
GET /signalk/v2/api/resources/charts/` 
```

- Return metadata for selected chart

```bash
# v1 API
GET /signalk/v1/api/resources/charts/${identifier}` 

# v2 API
GET /signalk/v2/api/resources/charts/${identifier}` 
```

#### Chart Tiles
Chart tiles are retrieved using the url defined in the chart metadata.

For chart files placed in the path(s) defined in the plugin configuration, the url will be:

```bash
/chart-tiles/${identifier}/${z}/${x}/${y}
```

#### Mapbox Styles

For Mapbox Styles JSON files the url returned in the metadata will be:

```bash
/chart-styles/${mapboxstyle.json}

# when access token is defined
/chart-styles/${mapboxstyle.json}?access_token=${token}
```


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
