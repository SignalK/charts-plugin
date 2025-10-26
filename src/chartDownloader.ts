import fs from "fs";
import path from "path";
import pLimit from "p-limit"
import booleanIntersects from '@turf/boolean-intersects'
import type { BBox, FeatureCollection, Polygon } from 'geojson'
import { polygon } from '@turf/helpers'

interface Tile {
    x: number
    y: number
    z: number
}

export enum DownloadStatus {
    NotStarted,
    Preparing,
    Downloading,
    Completed,
    Cancelled
}

export class ChartDownloader {
    public static ActiveDownloads: { [key: number]: ChartDownloader } = {};
    private static nextJobId = 1;

    private downloadStatus: DownloadStatus = DownloadStatus.NotStarted;
    private progress: number = 0;
    private totalTiles: number = 0;
    private downloadedTiles: number = 0;
    private failedTiles: number = 0;
    private cachedTiles: number = 0;

    private concurrentDownloadsLimit = 20;
    private regionName: string = "";
    private cancelRequested: boolean = false;


    constructor(private urlBase: string, private chartsPath: string, private provider: any) {}

    public static createAndRegister(urlBase: string, chartsPath: string, provider: any): { jobId: number, downloader: ChartDownloader } {
        const downloader = new ChartDownloader(urlBase, chartsPath, provider);
        const jobId = this.nextJobId++;
        this.ActiveDownloads[jobId] = downloader;
        return { jobId, downloader };
    }


    /**
     * Download map tiles for a specific region.
     * @param region
     * @param maxZoom Maximum zoom level to download
     */
    async downloadTiles(regionGUID: string, maxZoom: number): Promise<void> {
        this.downloadStatus = DownloadStatus.Preparing;
        const region = await this.getRegion(regionGUID);
        const geojson = this.convertRegionToGeoJSON(region);
        const tiles = this.getTilesForGeoJSON(geojson, this.provider.minzoom, maxZoom);
        const tileToDownload = await this.filterCachedTiles(tiles);
        
        this.totalTiles = tiles.length;
        this.downloadedTiles = 0;
        this.cachedTiles = this.totalTiles - tileToDownload.length;
        this.regionName = region.name || "";

        this.downloadStatus = DownloadStatus.Downloading;
        const limit = pLimit(this.concurrentDownloadsLimit); // concurrent download limit
        const promises: Promise<void>[] = [];
        for (const tile of tileToDownload) {
            if (this.cancelRequested) break;
            promises.push(limit(async () => {
                if (this.cancelRequested) return;
                const buffer = await ChartDownloader.fetchTile(this.chartsPath, this.provider, tile);
                if (this.cancelRequested) return;
                if (buffer === null) {
                    this.failedTiles += 1;
                } else {
                    this.downloadedTiles += 1;
                }
            }));
        }
        try {
            await Promise.all(promises);
            
        } catch (err) {
            // silent failure, caller can log if needed
            console.error(`Error downloading tiles:`, err);
        }
        if (this.cancelRequested) {
            this.downloadStatus = DownloadStatus.Cancelled;
            return;
        }
        this.downloadStatus = DownloadStatus.Completed;
    }

    async deleteTiles(regionGUID: string): Promise<void> {
        const region = await this.getRegion(regionGUID);
        const geojson = this.convertRegionToGeoJSON(region);
        const tiles = this.getTilesForGeoJSON(geojson, this.provider.minzoom, this.provider.maxzoom);
        for (const tile of tiles) {
            if (this.cancelRequested) break;
            const tilePath = path.join(this.chartsPath, `${this.provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${this.provider.format}`);
            if (fs.existsSync(tilePath)) {
                try {
                    await fs.promises.unlink(tilePath);
                } catch (err) {
                    console.error(`Error deleting cached tile ${tilePath}:`, err);
                }
            }
        }
        this.downloadStatus = DownloadStatus.Completed;
    }

    public cancelDownload() {
        this.cancelRequested = true;
    }

    async filterCachedTiles(allTiles: Tile[]): Promise<Tile[]> {
        const uncachedTiles: Tile[] = [];
        for (const tile of allTiles) {
            const tilePath = path.join(this.chartsPath, `${this.provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${this.provider.format}`);
            if (!fs.existsSync(tilePath)) {
                uncachedTiles.push(tile);
            }
        }
        return uncachedTiles;
    }

    public progressInfo(){
        return {
            chartName: this.provider.name,
            regionName: this.regionName,
            totalTiles: this.totalTiles,
            downloadedTiles: this.downloadedTiles,
            cachedTiles: this.cachedTiles,
            failedTiles: this.failedTiles,
            progress: this.totalTiles > 0 ? (this.downloadedTiles + this.cachedTiles) / this.totalTiles : 0,
            status: this.downloadStatus
        };
    }

    static async fetchTile(chartsPath: string, provider: any, tile: Tile): Promise<Buffer | null> {
        const tilePath = path.join(chartsPath, `${provider.name}`, `${tile.z}`, `${tile.x}`, `${tile.y}.${provider.format}`);
        if (fs.existsSync(tilePath)) {
            try {
                const data = await fs.promises.readFile(tilePath);
                return data;
            } catch (err) {
                console.error(`Error reading cached tile ${tilePath}:`, err);
            }
        }
        if (!provider.remoteUrl) {
            console.error(`No remote URL defined for cached provider ${provider.name}`);
            return null;
        }
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
        if (!fs.existsSync(path.dirname(tilePath))) {
            fs.mkdirSync(path.dirname(tilePath), { recursive: true });
        }
        await fs.promises.writeFile(tilePath, buffer);
        return buffer;
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

            const bbox = this.getBBox(feature.geometry as Polygon);
            for (let z = zoomMin; z <= zoomMax; z++) {
                const [minX, minY] = this.lonLatToTileXY(bbox[0], bbox[3], z); // top-left
                const [maxX, maxY] = this.lonLatToTileXY(bbox[2], bbox[1], z); // bottom-right

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

    async getRegion(regionGUID: string): Promise<Record<string, any>> {
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


    convertRegionToGeoJSON(region: Record<string, any>): FeatureCollection {
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

        return {
            type: "FeatureCollection" as const,
            features: [geoFeature],
        };
    }

    private getBBox(geometry: Polygon): BBox {
        let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
        for (const ring of geometry.coordinates) {
            for (const [lon, lat] of ring) {
                minLon = Math.min(minLon, lon);
                minLat = Math.min(minLat, lat);
                maxLon = Math.max(maxLon, lon);
                maxLat = Math.max(maxLat, lat);
            }
        }
        return [minLon, minLat, maxLon, maxLat];
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