# Signal K server Charts plugin

Signal K Node server plugin to provide chart metadata, such as name, description and location of the actual chart tile data.

Chart metadata is derived from the following supported chart file types:
- MBTiles _(.mbtiles)_
- TMS _(tilemapresource.xml and tiles)_

Additionally, chart metadata can be entered via the plugin configuration for other chart sources and types _(e.g. WMS, WMTS, S-57 tiles and tilejson)_.

Chart metadata is made available to both v1 and v2 Signal K `resources` api paths.

| Server Version | API | Path |
|--- |--- |--- |
| 1.x.x | v1 | `/signalk/v1/api/resources/charts` |
| 2.x.x | v2 | `/signalk/v2/api/resources/charts` |

    
_Note: Version 2 resource paths will only be made available on Signal K server v2.0.0 and later_

## Usage

1. Install `@signalk/signalk-charts` from the Signal K Server Appstore

2. Configure the plugin in the Admin UI _(**Server -> Plugin Config -> Signal K Charts**)_ 

3. Activate the plugin

Chart metadata will then be available to client apps via the resources api `/resources/charts` for example:
- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk)
- [Tuktuk Chart Plotter](https://www.npmjs.com/package/tuktuk-chart-plotter)


## Configuration


### Local Chart Files

If you are using chart files stored on the Signal K Server you will need to add the locations where the chart files are stored so the plugin can generate the chart metadata.

Do this by adding "Chart paths" and providing the path to each folder on the Signal K Server where chart files are stored. _(Defaults to `${signalk-configuration-path}/charts`)_

<img src="https://user-images.githubusercontent.com/1435910/39382493-57c1e4dc-4a6e-11e8-93e1-cedb4c7662f4.png" alt="Chart paths configuration" width="450"/>

When chart files are added to the folder(s) they will be processed by the plugin and the chart metadata will be available _(after the plugin has been restarted)_.


### Online chart providers

If your chart source is not local to the Signal K Server you can add "Online Chart Providers" and enter the required charts metadata for the source.

You will need to provide the following information:
1. A chart name for client applications to display
2. The URL to the chart source
3. Select the chart image format
4. The minimum and maximum zoom levels where chart data is available.

You can also provide a description detailing the chart content.

<img src="https://github.com/user-attachments/assets/77cb3aaf-5471-4e55-b05d-aad70cacab6a" alt="Online chart providers configuration" width="450"/>

For WMS & WMTS sources you can specify the layers you wish to display.

<img src="https://github.com/user-attachments/assets/b9bfba38-8468-4eca-aeb3-96a80fcbc7a6" alt="Online chart provider layers" width="450"/>


### Supported chart formats

- [MBTiles](https://github.com/mapbox/mbtiles-spec) files
- Directory with cached [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification) tiles and `tilemapresource.xml`
- Directory with XYZ tiles and `metadata.json`
- Online [TMS](https://wiki.osgeo.org/wiki/Tile_Map_Service_Specification)

Publicly available MBTiles charts can be found from:
- [NOAA Nautical charts](https://distribution.charts.noaa.gov/ncds/index.html)
- [Finnish Transport Agency nautical charts](https://github.com/vokkim/rannikkokartat-mbtiles)
- [Signal K World Coastline Map](https://github.com/netAction/signalk-world-coastline-map), download [MBTiles release](https://github.com/netAction/signalk-world-coastline-map/releases/download/v1.0/signalk-world-coastline-map-database.tgz)


---

### API

Plugin adds support for `/resources/charts` endpoints described in [Signal K specification](http://signalk.org/specification/1.0.0/doc/otherBranches.html#resourcescharts):

- List available charts

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

For local chart files located in the Chart Path(s) defined in the plugin configuration, the url will be:

```bash
/signalk/chart-tiles/${identifier}/${z}/${x}/${y}
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
