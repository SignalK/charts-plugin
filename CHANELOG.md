## Change Log

### 3.1.0

- **Added**: Detection, processing and serving of mapbox style json files. Files served from `/chart-styles` 

- **Added**: Ability to provide a Mapbox access token in the plugin configuration. 

- **Added**: Watch chart folders for changes and refresh chart providers (#28) 

- **Updated**: Move the serving of map tiles out from under `resources/charts` to `/chart-tiles` to better aligns with v2 multiple-provider support.

- **Updated**: Updated package dependencies (#35)

---

### 3.0.0

- **Added**: Signal K v2 Resources API support.
- **Updated**: Ported to Typescript.