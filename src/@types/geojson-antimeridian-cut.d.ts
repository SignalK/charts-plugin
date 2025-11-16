declare module 'geojson-antimeridian-cut' {
  import { Feature, FeatureCollection, Geometry } from 'geojson'
  export default function splitGeoJSON<
    T extends Feature<Geometry> | FeatureCollection
  >(geojson: T): T
}
