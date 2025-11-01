import fs from "fs";
import path from "path";
import pLimit from "p-limit"
import type { BBox, FeatureCollection, Polygon, MultiPolygon, Feature, Position } from 'geojson'
import splitGeoJSON from 'geojson-antimeridian-cut';
import booleanIntersects from '@turf/boolean-intersects'
import { bbox } from '@turf/bbox'
import { polygon } from '@turf/helpers'
import checkDiskSpace from "check-disk-space";
import { ChartProvider } from "./types";

export interface Tile {
    x: number
    y: number
    z: number
}

export enum Status {
    Stopped,
    Running,
    
}

export class ChartSeedingManager {
    // Placeholder for future cache management methods
    public static ActiveJobs: { [key: number]: ChartDownloader } = {};

    public static async createJob(urlBase: string, chartsPath: string, provider: any, maxZoom: number, regionGUI: string | undefined = undefined, bbox: BBox | undefined = undefined, tile: Tile | undefined = undefined): Promise<ChartDownloader> {
        const downloader = new ChartDownloader(urlBase, chartsPath, provider);
        if (regionGUI)
            downloader.initalizeJobFromRegion(regionGUI, maxZoom);
        else if (bbox)
            downloader.initializeJobFromBBox(bbox, maxZoom);
        else if (tile) {
            downloader.initializeJobFromTile(tile, maxZoom);
        }
        this.ActiveJobs[downloader.ID] = downloader;
        return downloader;
    }

    public static registerRoutes(app: any){
        
    }
}

export class ChartDownloader {
    private static DISK_USAGE_LIMIT = 1024 * 1024 * 1024; // 1 GB
    private static nextJobId = 1;

    private id : number = ChartDownloader.nextJobId++;
    private maxZoom : number = 15;
    private status: Status = Status.Stopped;
    private totalTiles: number = 0;
    private downloadedTiles: number = 0;
    private failedTiles: number = 0;
    private cachedTiles: number = 0;

    private concurrentDownloadsLimit = 20;
    private areaDescription: string = "";
    private cancelRequested: boolean = false;

    private tiles: Tile[] = [];
    private tilesToDownload: Tile[] = [];


    constructor(private urlBase: string, private chartsPath: string, private provider: any) { 

    }

    get ID(): number {
        return this.id;
    }


    public async initalizeJobFromRegion(regionGUID: string, maxZoom: number): Promise<void> {
        const region = await this.getRegion(regionGUID);
        const geojson = this.convertRegionToGeoJSON(region);
        this.tiles = this.getTilesForGeoJSON(geojson, this.provider.minzoom, maxZoom);
        this.tilesToDownload = this.filterCachedTiles(this.tiles);

        this.status = Status.Stopped;
        this.totalTiles = this.tiles.length;
        this.cachedTiles = this.totalTiles - this.tilesToDownload.length;
        this.areaDescription = `Region: ${region.name || ""}`;
        this.maxZoom = maxZoom;
    }

    public async initializeJobFromBBox(bbox: BBox, maxZoom: number): Promise<void> {
        this.tiles = this.getTilesForBBox(bbox, maxZoom);
        this.tilesToDownload = this.filterCachedTiles(this.tiles);

        this.status = Status.Stopped;
        this.totalTiles = this.tiles.length;
        this.cachedTiles = this.totalTiles - this.tilesToDownload.length;
        this.areaDescription = `BBox: [${bbox.join(", ")}]`;
        this.maxZoom = maxZoom;
    } 

     public async initializeJobFromTile(tile: Tile, maxZoom: number): Promise<void> {
        this.tiles = this.getSubTiles(tile, maxZoom);
        this.tilesToDownload = this.filterCachedTiles(this.tiles);

        this.status = Status.Stopped;
        this.totalTiles = this.tiles.length;
        this.cachedTiles = this.totalTiles - this.tilesToDownload.length;
        this.areaDescription = `Tile: [${tile.x}, ${tile.y}, ${tile.z}]`;
        this.maxZoom = maxZoom;
    } 

    /**
     * Download map tiles for a specific area.
     * 
     */
    async seedCache(): Promise<void> {  
        this.cancelRequested = false;
        this.status = Status.Running;
        this.tilesToDownload = await this.filterCachedTiles(this.tiles);
        this.downloadedTiles = 0;
        this.failedTiles = 0;
        this.cachedTiles = this.totalTiles - this.tilesToDownload.length;
        const limit = pLimit(this.concurrentDownloadsLimit); // concurrent download limit
        const promises: Promise<void>[] = [];
        let tileCounter = 0
        this.tilesToDownload = await this.filterCachedTiles(this.tiles);
        for (const tile of this.tilesToDownload) {
            if (this.cancelRequested) break;
            if (tileCounter % 1000 === 0 && tileCounter > 0) {
                try {
                    const { free } = await checkDiskSpace(this.chartsPath)
                    if (free < ChartDownloader.DISK_USAGE_LIMIT) {
                        console.warn(`Low disk space. Stopping download.`);
                        break;
                    }
                } catch (err) {
                    console.error(`Error checking disk space:`, err);
                    break;
                }
            }
            promises.push(limit(async () => {
                if (this.cancelRequested)
                    return;
                const buffer = await ChartDownloader.getTileFromCacheOrRemote(this.chartsPath, this.provider, tile);
                if (buffer === null) {
                    this.failedTiles += 1;
                } else {
                    this.downloadedTiles += 1;
                }
            }));
            tileCounter++
        }
        try {
            await Promise.all(promises);

        } catch (err) {
            // silent failure, caller can log if needed
            console.error(`Error downloading tiles:`, err);
        }
        this.status = Status.Stopped;
    }

    async deleteCache(): Promise<void> {
        this.status = Status.Running;
        for (const tile of this.tiles) {
            if (this.cancelRequested) break;
            const tilePath = path.join(this.chartsPath, `${this.provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${this.provider.format}`);
            if (fs.existsSync(tilePath)) {
                try {
                    fs.promises.unlink(tilePath);
                    this.cachedTiles -= 1;
                    this.cachedTiles = Math.max(this.cachedTiles, 0);
                } catch (err) {
                    console.error(`Error deleting cached tile ${tilePath}:`, err);
                }
            }
        }
        this.status = Status.Stopped;
    }

    public cancelJob() {
        this.cancelRequested = true;
    }

    private filterCachedTiles(allTiles: Tile[]): Tile[] {
        const uncachedTiles: Tile[] = [];
        for (const tile of allTiles) {
            const tilePath = path.join(this.chartsPath, `${this.provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${this.provider.format}`);
            if (!fs.existsSync(tilePath)) {
                uncachedTiles.push(tile);
            }
        }
        return uncachedTiles;
    }

    public info() {
        return {
            id: this.id,
            chartName: this.provider.name,
            regionName: this.areaDescription,
            totalTiles: this.totalTiles,
            downloadedTiles: this.downloadedTiles,
            cachedTiles: this.cachedTiles,
            failedTiles: this.failedTiles,
            progress: this.totalTiles > 0 ? (this.downloadedTiles + this.cachedTiles + this.failedTiles) / this.totalTiles : 0,
            status: this.status
        };
    }

    static async getTileFromCacheOrRemote(chartsPath: string, provider: any, tile: Tile): Promise<Buffer | null> {
        const tilePath = path.join(chartsPath, `${provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${provider.format}`);
        if (fs.existsSync(tilePath)) {
            try {
                const data = await fs.promises.readFile(tilePath);
                return data;
            } catch (err) {
                console.error(`Error reading cached tile ${tilePath}:`, err);
            }
        }
        const buffer = await this.fetchTileFromRemote(provider, tile);
        if (buffer) {
            if (!fs.existsSync(path.dirname(tilePath))) {
                fs.mkdirSync(path.dirname(tilePath), { recursive: true });
            }
            await fs.promises.writeFile(tilePath, buffer);
        }
        return buffer;
    }

    static async fetchTileFromRemote(provider: any, tile: Tile): Promise<Buffer | null> {
        const url = provider.remoteUrl
            .replace("{z}", tile.z.toString())
            .replace("{x}", tile.x.toString())
            .replace("{y}", tile.y.toString())
            .replace("{-y}", (Math.pow(2, tile.z) - 1 - tile.y).toString());
        const response = await fetch(url, {
            headers: provider.headers
        });
        if (!response.ok) {
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return buffer
    }

    getSubTiles(tile: Tile, maxZoom: number): Tile[] {
        const tiles: Tile[] = [tile];

        for (let z = tile.z + 1; z <= maxZoom; z++) {
            const zoomDiff = z - tile.z;
            const factor = Math.pow(2, zoomDiff);

            const startX = tile.x * factor;
            const startY = tile.y * factor;

            for (let x = startX; x < startX + factor; x++) {
                for (let y = startY; y < startY + factor; y++) {
                    tiles.push({ x, y, z });
                }
            }
        }

        return tiles;
    }

    /**
     * Get all tiles that intersect a bounding box up to a maximum zoom level.
     * bbox = [minLon, minLat, maxLon, maxLat]
     */
    getTilesForBBox(bbox: BBox, maxZoom: number): Tile[] {
        const tiles: Tile[] = [];
        let [minLon, minLat, maxLon, maxLat] = bbox;

        const crossesAntiMeridian = minLon > maxLon;

        // Helper to process a lon/lat box normally
        const processBBox = (lo1: number, la1: number, lo2: number, la2: number) => {
            for (let z = 0; z <= maxZoom; z++) {
                const [minX, maxY] = this.lonLatToTileXY(lo1, la1, z);
                const [maxX, minY] = this.lonLatToTileXY(lo2, la2, z);

                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        tiles.push({ x, y, z });
                    }
                }
            }
        };

        if (!crossesAntiMeridian) {
            // normal
            processBBox(minLon, minLat, maxLon, maxLat);
        } else {
            // crosses antimeridian — split into two boxes:
            // [minLon -> 180] and [-180 -> maxLon]
            processBBox(minLon, minLat, 180, maxLat);
            processBBox(-180, minLat, maxLon, maxLat);
        }

        return tiles;
    }

    getTilesForGeoJSON(
        geojson: FeatureCollection,
        zoomMin = 1,
        zoomMax = 14
    ): Tile[] {
        const tiles: Tile[] = [];

        for (const feature of geojson.features) {
            if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") {
                console.warn("Skipping non-polygon feature");
                continue;
            }
            
            const boundingBox = bbox(feature.geometry as Polygon); // [minX, minY, maxX, maxY]
            for (let z = zoomMin; z <= zoomMax; z++) {
                const [minX, minY] = this.lonLatToTileXY(boundingBox[0], boundingBox[3], z); // top-left
                const [maxX, maxY] = this.lonLatToTileXY(boundingBox[2], boundingBox[1], z); // bottom-right

                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        const tileBbox = this.tileToBBox(x, y, z);
                        const tilePoly = this.bboxPolygon(tileBbox);

                        if (booleanIntersects(feature as any, tilePoly)) {
                            tiles.push({ x, y, z });
                        }
                    }
                }
            }
        }

        return tiles;
    }


    private async getRegion(regionGUID: string): Promise<Record<string, any>> {
        let regionData: any
        const resp = await fetch(`${this.urlBase}/signalk/v2/api/resources/regions/${regionGUID}`)
        if (!resp.ok) {
            const body = await resp.text().catch(() => '')
            console.error(`Failed to fetch region ${regionGUID}: ${resp.status} ${resp.statusText} ${body}`)
            return {};
        }
        regionData = await resp.json()
        return regionData;
    }


    private convertRegionToGeoJSON(region: Record<string, any>): FeatureCollection {
        const feature = region.feature;
        if (!feature || feature.type !== "Feature" || !feature.geometry) {
            throw new Error("Invalid region: missing feature or geometry");
        }

        const geoFeature = {
            type: "Feature" as const,
            id: feature.id || undefined,
            geometry: feature.geometry,
            properties: {
                name: region.name || "",
                description: region.description || "",
                timestamp: region.timestamp || "",
                source: region.$source || "",
                ...feature.properties,
            },
        };
        const splitGeoFeature = splitGeoJSON(geoFeature);
        const features: Feature<Polygon>[] = [];

        const pushFeaturePolygon = (orig: Feature, coords: Position[][], idx?: number) => {
            const poly: Feature<Polygon> = {
            type: "Feature",
            id: idx != null && orig.id ? `${orig.id}-${idx}` : orig.id,
            geometry: {
                type: "Polygon",
                coordinates: coords
            },
            properties: orig.properties || {}
            };
            features.push(poly);
        };

        const f = splitGeoFeature as Feature;
        if (f.geometry && f.geometry.type === "MultiPolygon") {
            for (let i = 0; i < (f.geometry as MultiPolygon).coordinates.length; i++) {
                pushFeaturePolygon(f, (f.geometry as MultiPolygon).coordinates[i], i);
            }
        } else if (f.geometry && f.geometry.type === "Polygon") {
            features.push(f as Feature<Polygon>);
        }

        return {
            type: "FeatureCollection" as const,
            features
        };
    }

    private lonLatToTileXY(lon: number, lat: number, zoom: number): [number, number] {
        const n = 2 ** zoom;
        const x = Math.floor(((lon + 180) / 360) * n);
        const y = Math.floor(
            ((1 -
                Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
                Math.PI) /
                2) *
            n
        );
        return [x, y];
    }

    private tileToBBox(x: number, y: number, z: number): BBox {
        const n = 2 ** z;
        const lon1 = (x / n) * 360 - 180;
        const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
        const lon2 = ((x + 1) / n) * 360 - 180;
        const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
        return [lon1, lat2, lon2, lat1];
    }

    private bboxPolygon(boundingBox: BBox) {
        const [minLon, minLat, maxLon, maxLat] = boundingBox;
        return polygon([[
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat]
        ]]);
    }
}