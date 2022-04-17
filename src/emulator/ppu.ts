import { Bus, ReadHandler, WriteHandler } from './bus';
import { Interrupt, irq } from './interrupt';

import { PALETTE_CLASSIC } from './palette';
import { System } from './system';
import { hex8 } from '../helper/format';

const enum reg {
    base = 0xff40,
    lcdc = 0x00,
    stat = 0x01,
    scy = 0x02,
    scx = 0x03,
    ly = 0x04,
    lyc = 0x05,
    dma = 0x06,
    bgp = 0x07,
    obp0 = 0x08,
    obp1 = 0x09,
    wy = 0x0a,
    wx = 0x0b,
}

export const enum ppuMode {
    hblank = 0,
    vblank = 1,
    oamScan = 2,
    draw = 3,
}

const enum lcdc {
    enable = 0x80,
    windowTileMapArea = 0x40,
    windowEnable = 0x20,
    bgTileDataArea = 0x10,
    bgTileMapArea = 0x08,
    objSize = 0x04,
    objEnable = 0x02,
    bgEnable = 0x02,
}

const enum stat {
    sourceLY = 0x40,
    sourceModeOAM = 0x20,
    sourceModeVblank = 0x10,
    sourceModeHblank = 0x08,
}

export class Ppu {
    constructor(private system: System, private interrupt: Interrupt) {}

    install(bus: Bus): void {
        for (let i = 0x8000; i < 0xa000; i++) {
            bus.map(i, this.vramRead, this.vramWrite);
        }

        for (let i = 0xfe00; i < 0xfea0; i++) {
            bus.map(i, this.oamRead, this.oamWrite);
        }

        for (let i = 0; i <= reg.wx; i++) {
            bus.map(reg.base + i, this.registerRead, this.registerWrite);
        }

        bus.map(reg.base + reg.lcdc, this.registerRead, this.lcdcWrite);
        bus.map(reg.base + reg.ly, this.lyRead, this.stubWrite);
        bus.map(reg.base + reg.stat, this.statRead, this.registerWrite);
        bus.map(reg.base + reg.dma, this.registerRead, this.dmaWrite);
        bus.map(reg.base + reg.bgp, this.registerRead, this.bgpWrite);

        this.bus = bus;
    }

    reset(): void {
        this.clockInMode = 0;
        this.mode = ppuMode.oamScan;
        this.scanline = 0;
        this.frame = 0;
        this.stat = false;
        this.dmaInProgress = false;
        this.dmaCycle = 0;
        this.skipFrame = false;

        this.vram.fill(0);
        this.oam.fill(0);
        this.reg.fill(0);

        this.reg[reg.lcdc] = lcdc.enable;

        this.paletteBG.set(PALETTE_CLASSIC.subarray(0, 4));
        this.frontBuffer.fill(PALETTE_CLASSIC[4]);
        this.backBuffer.fill(PALETTE_CLASSIC[4]);
    }

    cycle(systemClocks: number): void {
        while (this.dmaInProgress && systemClocks > 0) {
            this.dmaCycle++;
            systemClocks--;

            if (this.dmaCycle > 640) this.executeDma();
            if ((this.reg[reg.lcdc] & lcdc.enable) !== 0) this.consumeClocks(1);
        }

        if ((this.reg[reg.lcdc] & lcdc.enable) === 0) return;

        while (systemClocks > 0) {
            systemClocks -= this.consumeClocks(systemClocks);
            this.updateStat();
        }
    }

    printState(): string {
        return `scanline=${this.scanline} mode=${this.mode} clockInMode=${this.clockInMode} frame=${this.frame} lcdc=${hex8(this.reg[reg.lcdc])} dma=${
            this.dmaInProgress ? 1 : 0
        } dmaCycle=${this.dmaCycle}`;
    }

    getFrameIndex(): number {
        return this.frame;
    }

    getFrameData(): ArrayBuffer {
        return this.frontBuffer.buffer;
    }

    getMode(): ppuMode {
        return this.mode;
    }

    private consumeClocks(clocks: number): number {
        switch (this.mode) {
            case ppuMode.oamScan:
                if (clocks + this.clockInMode >= 80) {
                    const consumed = 80 - this.clockInMode;

                    this.mode = ppuMode.draw;
                    this.clockInMode = 0;

                    return consumed;
                } else {
                    this.clockInMode += clocks;
                    return clocks;
                }

            case ppuMode.draw:
                if (clocks + this.clockInMode >= 172) {
                    const consumed = 172 - this.clockInMode;

                    this.mode = ppuMode.hblank;
                    this.clockInMode = 0;
                    this.renderLine();

                    return consumed;
                } else {
                    this.clockInMode += clocks;
                    return clocks;
                }

            case ppuMode.hblank:
                if (clocks + this.clockInMode >= 204) {
                    const consumed = 204 - this.clockInMode;

                    this.scanline++;
                    if (this.scanline === 144) {
                        this.mode = ppuMode.vblank;
                        this.interrupt.raise(irq.vblank);
                    } else {
                        this.mode = ppuMode.oamScan;
                    }
                    this.clockInMode = 0;

                    return consumed;
                } else {
                    this.clockInMode += clocks;
                    return clocks;
                }

            case ppuMode.vblank:
                if (clocks + this.clockInMode >= 4560) {
                    const consumed = 4560 - this.clockInMode;

                    this.mode = ppuMode.oamScan;
                    this.clockInMode = 0;
                    this.scanline = 0;

                    if (!this.skipFrame) {
                        this.swapBuffers();
                    }

                    this.skipFrame = false;

                    return consumed;
                } else {
                    this.clockInMode += clocks;
                    this.scanline = 144 + ((this.clockInMode / 456) | 0);
                    return clocks;
                }
        }
    }

    private updateStat(): void {
        const oldStat = this.stat;
        const statval = this.reg[reg.stat];

        this.stat =
            !!(this.reg[reg.lcdc] & lcdc.enable) &&
            ((!!(statval & stat.sourceLY) && this.scanline === this.reg[reg.lyc]) ||
                (!!(statval & stat.sourceModeOAM) && this.mode === ppuMode.oamScan) ||
                (!!(statval & stat.sourceModeVblank) && this.mode === ppuMode.vblank) ||
                (!!(statval & stat.sourceModeHblank) && this.mode === ppuMode.hblank));

        if (this.stat && !oldStat && (this.reg[reg.lcdc] & lcdc.enable) !== 0x00) this.interrupt.raise(irq.stat);
    }

    private executeDma(): void {
        this.bus.unlock();
        this.dmaInProgress = false;
        this.dmaCycle = 0;

        const base = this.reg[reg.dma] % 0xe0 << 8;

        for (let i = 0; i < 160; i++) {
            this.oam[i] = this.bus.read(base + i);
        }
    }

    private swapBuffers(): void {
        const frontBuffer = this.frontBuffer;

        this.frontBuffer = this.backBuffer;
        this.backBuffer = frontBuffer;
        this.frame = (this.frame + 1) | 0;
    }

    private renderLine(): void {
        const backgroundX = this.reg[reg.scx];
        const backgroundY = this.reg[reg.scy] + this.scanline;

        const bgTileNY = (backgroundY / 8) | 0;
        const bgTileY = backgroundY % 8;
        let bgTileX = backgroundX % 8;
        let bgTileNX = (backgroundX / 8) | 0;

        let bgTileData = this.backgroundTileData(bgTileNX, bgTileNY, bgTileY) << bgTileX;

        let pixelAddress = 160 * this.scanline;

        for (let x = 0; x < 160; x++) {
            // this assumes a little endian host
            const indexedBG = ((bgTileData & 0x8000) >>> 14) | ((bgTileData & 0x80) >>> 7);
            this.backBuffer[pixelAddress++] = this.paletteBG[indexedBG];

            if (bgTileX === 7) {
                bgTileNX++;
                bgTileX = 0;

                bgTileData = this.backgroundTileData(bgTileNX, bgTileNY, bgTileY);
            } else {
                bgTileX++;
                bgTileData <<= 1;
            }
        }
    }

    private backgroundTileData(nx: number, ny: number, y: number): number {
        const tileMapBase = this.reg[reg.lcdc] & lcdc.bgTileMapArea ? 0x1c00 : 0x1800;
        const index = this.vram[tileMapBase + (ny % 32) * 32 + (nx % 32)];

        if (index >= 0x80) {
            return this.vram16[0x0400 + 8 * (index - 0x80) + y];
        } else {
            const tildeDataBase = this.reg[reg.lcdc] & lcdc.bgTileDataArea ? 0x0000 : 0x800;

            return this.vram16[tildeDataBase + 8 * index + y];
        }
    }

    private stubWrite: WriteHandler = () => undefined;

    private vramRead: ReadHandler = (address) => ((this.reg[reg.lcdc] & lcdc.enable) === 0 || this.mode !== ppuMode.draw ? this.vram[address & 0x1fff] : 0xff);
    private vramWrite: WriteHandler = (address, value) =>
        ((this.reg[reg.lcdc] & lcdc.enable) === 0 || this.mode !== ppuMode.draw) && (this.vram[address & 0x1fff] = value);

    private oamRead: ReadHandler = (address) =>
        (this.reg[reg.lcdc] & lcdc.enable) === 0 || (this.mode !== ppuMode.draw && this.mode !== ppuMode.oamScan) ? this.oam[address & 0xff] : 0xff;
    private oamWrite: WriteHandler = (address, value) =>
        ((this.reg[reg.lcdc] & lcdc.enable) === 0 || (this.mode !== ppuMode.draw && this.mode !== ppuMode.oamScan)) && (this.oam[address & 0xff] = value);

    private registerRead: ReadHandler = (address) => this.reg[address - reg.base];
    private registerWrite: WriteHandler = (address, value) => {
        this.reg[address - reg.base] = value;
        this.updateStat();
    };

    private statRead: ReadHandler = () => (this.reg[reg.stat] & 0xf8) | (this.reg[reg.lyc] === this.scanline ? 0x04 : 0) | this.mode;

    private lyRead: ReadHandler = () => this.scanline;

    private dmaWrite: WriteHandler = (_, value) => {
        this.reg[reg.dma] = value;

        this.dmaCycle = 0;
        this.dmaInProgress = true;
        this.bus.lock();
    };

    private bgpWrite: WriteHandler = (_, value) => {
        value &= 0xff;
        this.reg[reg.bgp] = value;

        for (let i = 0; i < 4; i++) {
            this.paletteBG[i] = PALETTE_CLASSIC[(value >> (2 * i)) & 0x03];
        }
    };

    private lcdcWrite: WriteHandler = (_, value) => {
        const oldValue = this.reg[reg.lcdc];
        this.reg[reg.lcdc] = value;

        if (~oldValue & this.reg[reg.lcdc] & lcdc.enable) {
            this.skipFrame = true;
        }

        if (oldValue & ~this.reg[reg.lcdc] & lcdc.enable) {
            this.backBuffer.fill(PALETTE_CLASSIC[4]);
            this.swapBuffers();
        }
    };

    private clockInMode = 0;
    private scanline = 0;
    private frame = 0;
    private mode: ppuMode = ppuMode.oamScan;
    private skipFrame = false;

    private vram = new Uint8Array(0x2000);
    private oam = new Uint8Array(0xa0);
    private stat = false;

    private vram16 = new Uint16Array(this.vram.buffer);

    private dmaInProgress = false;
    private dmaCycle = 0;

    private reg = new Uint8Array(reg.wx + 1);
    private bus!: Bus;

    private paletteBG = PALETTE_CLASSIC.slice();

    private frontBuffer = new Uint32Array(160 * 144);
    private backBuffer = new Uint32Array(160 * 144);
}
