import { SystemInterface } from './system';

export type ReadHandler = (address: number) => number;
export type WriteHandler = (address: number, value: number) => void;

export class Bus {
    constructor(private system: SystemInterface) {
        for (let i = 0; i < 0x10000; i++) {
            this.readMap[i] = this.invalidRead;
            this.writeMap[i] = this.invalidWrite;
        }
    }

    private invalidRead: ReadHandler = (address) => {
        this.system.break(`invalid read from 0x${address.toString(16).padStart(4, '0')}`);

        return 0;
    };

    private invalidWrite: WriteHandler = (address) => {
        this.system.break(`invalid write to 0x${address.toString(16).padStart(4, '0')}`);
    };

    public readonly readMap = new Array<ReadHandler>(0x10000);
    public readonly writeMap = new Array<WriteHandler>(0x10000);
}
