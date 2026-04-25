declare module '@geo-maps/earth-seas-10m' {
  import type { GeometryCollection, MultiPolygon } from 'geojson'
  // The package ships a single MultiPolygon-only GeometryCollection covering
  // the world's oceans and seas at 10m resolution. Calling the factory parses
  // and returns it; callers cache the result so the ~36 MB JSON is read once.
  function getMap(): GeometryCollection<MultiPolygon>
  export default getMap
}
