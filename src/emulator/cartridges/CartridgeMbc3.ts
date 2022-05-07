import { CartridgeBase, CartridgeType } from './CartridgeBase';
import { ReadHandler, WriteHandler } from '../bus';

import { Bus } from '../bus';
import { System } from '../system';
import { hex8 } from '../../helper/format';

export class CartridgeMbc3 extends CartridgeBase {
    constructor(image: Uint8Array, system: System) {
        super(image, system);

        const romSize = this.size();
        const ramSize = this.ramSize();

        if (romSize % 0x4000 !== 0 || romSize > 2 * 1024 * 1024 || romSize < 2 * 0x4000) {
            throw new Error('invalid ROM size; not a MBC3 image');
        }

        if (ramSize % 0x2000 !== 0) {
            throw new Error('invalid RAM size; not a MBC3 image');
        }

        this.ram = new Uint8Array(ramSize);
        this.romBanks = new Array((romSize / 0x4000) | 0);
        this.ramBanks = new Array((ramSize / 0x2000) | 0);

        for (let i = 0; i < this.romBanks.length; i++) {
            this.romBanks[i] = this.image.subarray(i * 0x4000, (i + 1) * 0x4000);
        }

        this.romBank1 = this.romBanks[this.romBankIndex];

        if (ramSize > 0) {
            for (let i = 0; i < this.ramBanks.length; i++) {
                this.ramBanks[i] = this.ram.subarray(i * 0x2000, (i + 1) * 0x2000);
            }

            this.ramBank = this.ramBanks[this.ramBankIndex];
        } else {
            this.ramBank = this.ram;
        }
    }

    install(bus: Bus): void {
        super.install(bus);

        for (let i = 0x0000; i < 0x2000; i++) bus.map(i, this.readBank0, this.writeRamEnable);
        for (let i = 0x2000; i < 0x4000; i++) bus.map(i, this.readBank0, this.writeRomBankIndex);
        for (let i = 0x4000; i < 0x6000; i++) bus.map(i, this.readBank1, this.writeRamBankIndex);
        for (let i = 0x6000; i < 0x8000; i++) bus.map(i, this.readBank1, this.writeLatch);
        for (let i = 0xa000; i < 0xc000; i++) bus.map(i, this.readBankRam, this.writeBankRam);
    }

    reset(savedRam?: Uint8Array): void {
        this.romBankIndex = 0x01;
        this.romBank1 = this.romBanks[this.romBankIndex];

        this.ramBankIndex = 0x00;
        this.ramBank = this.ram.length > 0 ? this.ramBanks[this.ramBankIndex] : this.ram;

        this.halt = false;
        this.lastLatch = 0xff;

        this.ramEnable = false;
        this.registerSelect = 0;
        this.lastLatch = 0xff;

        switch (this.type()) {
            case CartridgeType.mbc3_ram_battery:
            case CartridgeType.mbc3_timer_battery:
            case CartridgeType.mbc3_timer_ram_battery: {
                const saveSize = this.ram.length + 4;
                if (savedRam && savedRam.length === saveSize) {
                    if (this.ram.length > 0) {
                        this.ram.set(savedRam.subarray(0, this.ram.length));
                    }

                    this.referenceTimestamp =
                        savedRam[this.ram.length] |
                        (savedRam[this.ram.length + 1] << 8) |
                        (savedRam[this.ram.length + 2] << 16) |
                        (savedRam[this.ram.length + 3] << 24);
                }

                break;
            }

            default:
                this.ram.fill(0);
                this.referenceTimestamp = (Date.now() / 1000) | 0;
        }

        this.latch();
    }

    clearRam(): void {
        this.ram.fill(0);
        this.referenceTimestamp = (Date.now() / 1000) | 0;
    }

    printState(): string {
        this.materializeClock();

        return `romBank=${hex8(this.romBankIndex)} ramEnable=${this.ramEnable} ramBank=${hex8(this.ramBankIndex)} days=${this.daysCurrent} hours=${
            this.hoursCurrent
        } minutes=${this.minutesCurrent} seconds=${this.secondsCurrent}`;
    }

    getRam(): Uint8Array | undefined {
        switch (this.type()) {
            case CartridgeType.mbc3_ram_battery:
            case CartridgeType.mbc3_timer_battery:
            case CartridgeType.mbc3_timer_ram_battery: {
                const save = new Uint8Array(this.ram.length + 4);
                save.set(this.ram);

                save[this.ram.length] = this.referenceTimestamp;
                save[this.ram.length + 1] = this.referenceTimestamp >>> 8;
                save[this.ram.length + 2] = this.referenceTimestamp >>> 16;
                save[this.ram.length + 3] = this.referenceTimestamp >>> 24;

                return save;
            }

            default:
                return undefined;
        }
    }

    private latch(): void {
        this.materializeClock();

        this.secondsCurrent = this.secondsLatched;
        this.minutesCurrent = this.minutesLatched;
        this.hoursCurrent = this.hoursLatched;
        this.daysCurrent = this.daysLatched;
    }

    private materializeClock(): void {
        let time = ((Date.now() / 1000) | 0) - this.referenceTimestamp;
        if (time < 0) time = 0;

        this.daysCurrent = (time / (24 * 3600)) | 0;
        time -= this.daysCurrent * 24 * 3600;

        this.hoursCurrent = (time / 3600) | 0;
        time -= this.daysCurrent * 3600;

        this.minutesCurrent = (time / 60) | 0;
        time -= this.minutesCurrent * 60;

        this.secondsCurrent = time;
    }

    private readRegister(register: number): number {
        switch (register) {
            case 0x08:
                return this.secondsLatched;

            case 0x09:
                return this.minutesLatched;

            case 0x0a:
                return this.hoursLatched;

            case 0x0b:
                return this.daysLatched & 0xff;

            case 0x0c:
                return ((this.daysLatched & 0x0100) >>> 8) | (this.halt ? 0x40 : 0) | (this.daysLatched > 0x01ff ? 0x80 : 0);

            default:
                return 0x00;
        }
    }

    private writeRegister(register: number, value: number) {
        switch (register) {
            case 0x08:
                if (!this.halt) this.materializeClock();
                this.secondsCurrent = value & 60;
                if (!this.halt) this.updateClock();
                break;

            case 0x09:
                if (!this.halt) this.materializeClock();
                this.minutesCurrent = value & 60;
                if (!this.halt) this.updateClock();
                break;

            case 0x0a:
                if (!this.halt) this.materializeClock();
                this.hoursCurrent = value & 24;
                if (!this.halt) this.updateClock();
                break;

            case 0x0b:
                if (!this.halt) this.materializeClock();
                this.daysCurrent = (this.daysCurrent & ~0xff) | value;
                if (!this.halt) this.updateClock();
                break;

            case 0x0c:
                if (!this.halt) this.materializeClock();
                this.halt = (value & 0x40) !== 0;
                this.daysCurrent = (this.daysCurrent & 0xff) | ((value & 0x01) << 8);
                if (!this.halt) this.updateClock();
                break;
        }
    }

    private updateClock(): void {
        const time = (this.daysCurrent & 0x01ff) * 24 * 3600 + (this.hoursCurrent % 24) * 3600 + (this.minutesCurrent % 60) * 60 + (this.secondsCurrent % 60);

        this.referenceTimestamp = ((Date.now() / 1000) | 0) - time;
    }

    private readBank0: ReadHandler = (address) => this.image[address];
    private readBank1: ReadHandler = (address) => this.romBank1[address & 0x3fff];
    private readBankRam: ReadHandler = (address) => {
        if (!this.ramEnable) return 0xff;

        return this.registerSelect > 0 ? this.readRegister(this.registerSelect) : this.ramBank[address - 0xa000];
    };

    private writeRamEnable: WriteHandler = (_, value) => (this.ramEnable = value === 0x0a && this.ram.length > 0);
    private writeRomBankIndex: WriteHandler = (_, value) => {
        this.romBankIndex = value === 0x00 ? 0x01 : value % this.romBanks.length;
        this.romBank1 = this.romBanks[this.romBankIndex];
    };
    private writeRamBankIndex: WriteHandler = (_, value) => {
        if (value <= 0x03) {
            this.ramBankIndex = value % this.ramBanks.length;
            this.ramBank = this.ramBanks[this.ramBankIndex];
            this.registerSelect = 0;
        } else {
            this.registerSelect = value;
        }
    };
    private writeLatch: WriteHandler = (_, value) => {
        if (value === 0x01 && this.lastLatch === 0x00) this.latch();
        this.lastLatch = value;
    };
    private writeBankRam: WriteHandler = (address, value) => {
        if (!this.ramEnable) return;

        this.registerSelect > 0 ? this.writeRegister(this.registerSelect, value) : (this.ramBank[address - 0xa000] = value);
    };

    private romBank1!: Uint8Array;
    private romBankIndex = 0x01;
    private romBanks: Array<Uint8Array>;

    private ram: Uint8Array;
    private ramBanks: Array<Uint8Array>;
    private ramBankIndex = 0x00;
    private ramBank!: Uint8Array;

    private secondsLatched = 0;
    private minutesLatched = 0;
    private hoursLatched = 0;
    private daysLatched = 0;

    private secondsCurrent = 0;
    private minutesCurrent = 0;
    private hoursCurrent = 0;
    private daysCurrent = 0;

    private halt = false;
    private ramEnable = false;
    private registerSelect = 0;

    private lastLatch = 0xff;
    private referenceTimestamp = (Date.now() / 1000) | 0;
}
