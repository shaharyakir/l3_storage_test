import { IPFSHash, IPFSProvider, MutableDFile, AppendOnlyDFile } from "./dfile";

// todo str
export type BChainAddress = string;
type BChainData = string;

export interface BChainProvider {
  update(arg0: string, _hash: string);
  readData(contractAddr: BChainAddress): Promise<BChainData>;
}

type MemPoolContents = Record<string, any[]>;

export interface MemPool {
  appendData(topic: string, data: any): Promise<void>;
  dump(): Promise<{ contents: MemPoolContents; onDone: () => void }>;
  getContents(): Promise<MemPoolContents>;
}

class InMemoryMemPool implements MemPool {
  async getContents(): Promise<MemPoolContents> {
    const dataByTopic = {};

    this.#data.forEach(([_, k, v]) => {
      if (!dataByTopic[k]) dataByTopic[k] = [];
      dataByTopic[k].push(v);
    });

    return dataByTopic;
  }

  #data: any[] = [];

  async appendData(topic: string, data: any) {
    if (this.#data.find((d) => JSON.stringify(d) === JSON.stringify(data)))
      throw "KOKO!!";
    this.#data.push([Date.now(), topic, data]);
  }

  async dump(): Promise<{ contents: MemPoolContents; onDone: () => void }> {
    const dataByTopic = await this.getContents();

    // TODO this is a dangerous side effect, we should consider carefully what triggers clearing the mempool
    // especially considering data keeps flowing in (distributed/async etc)
    // this.#data = [];

    const maxTs = this.#data.reduce(
      (prev, curr) => Math.max(prev, curr[0]),
      -1
    );

    const currLength = this.#data.length;

    return {
      contents: dataByTopic,
      onDone: () => {
        this.#data = this.#data.slice(currLength);
      },
    };
  }
}

export class RootWriter {
  #ipfsProvider: IPFSProvider;
  #bchainProvider: BChainProvider;
  #rootContract: string;
  _hash: IPFSHash;
  #topicsRootDFile: MutableDFile<IPFSHash>;
  #mempool: InMemoryMemPool;
  #topicsDFiles: { [k: string]: string };

  constructor(
    ipfsProvider: IPFSProvider,
    bchainProvider: BChainProvider,
    rootContract: BChainAddress
  ) {
    this.#ipfsProvider = ipfsProvider;
    this.#bchainProvider = bchainProvider;
    this.#rootContract = rootContract;
    this.#mempool = new InMemoryMemPool();
  }

  static async init(
    ipfsProvider: IPFSProvider,
    bchainProvider: BChainProvider,
    rootContract: BChainAddress
  ) {
    const rw = new RootWriter(ipfsProvider, bchainProvider, rootContract);
    await rw.init();
    return rw;
  }

  async init() {
    // TODO should throw for unpersisted data? "if isModified"
    this._hash = (await this.#bchainProvider.readData(
      this.#rootContract
    )) as IPFSHash;

    this.#topicsRootDFile = await MutableDFile.from<IPFSHash>(
      this._hash,
      this.#ipfsProvider
    );
    this.#topicsDFiles = this.#topicsRootDFile.readLatest();
  }

  // TODO if fromHash==toHash
  async getTopicContents(
    topic: string,
    toHash?: IPFSHash
  ): Promise<{
    data: any[];
    hash: string;
  }> {
    const fromHash = this.#topicsDFiles[topic];
    const storageContents = await AppendOnlyDFile.read({
      fromHash,
      toHash,
      ipfsProvider: this.#ipfsProvider,
    });
    const mempoolContents = (await this.#mempool.getContents())[topic] ?? [];
    return {
      data: [...storageContents, ...mempoolContents],
      hash: fromHash,
    };
  }

  async appendData(topic: string, data: any) {
    await this.#mempool.appendData(topic, data);
  }

  // TODO election etc
  // TODO flow: 1. initialize, 2. fetch data (i'm not the leader), 3. close data (i'm the leader)
  isInEpoch = false;

  async onEpoch() {
    if (!this.isInEpoch) {
      this.isInEpoch = true;
    } else {
      return;
    }
    const { contents: mempoolContents, onDone: onMempoolDone } =
      await this.#mempool.dump();
    if (Object.keys(mempoolContents).length > 0) {
      const latestTopics = this.#topicsRootDFile.readLatest();

      const updatedHashes = await Promise.all(
        Object.entries(mempoolContents).map(async ([k, v]) => {
          // TODO presumably only if changed, though unchanged dfiles should result in the same_hash :)
          const { hash } = await AppendOnlyDFile.write({
            lastKnownHash: latestTopics[k],
            ipfsProvider: this.#ipfsProvider,
            data: v,
          });
          return [k, hash];
        })
      );

      const { hash } = await this.#topicsRootDFile.write(
        Object.fromEntries(updatedHashes)
      );
      console.log("Wrote" + hash)
      this.#bchainProvider.update(this.#rootContract, hash);
      this._hash = hash;
      this.#topicsDFiles = this.#topicsRootDFile.readLatest();
      onMempoolDone();
    }
    this.isInEpoch = false;
  }

  async debugDump() {
    // console.log("================================");
    // for (const [topic, hash] of Object.entries(
    //   this.#topicsRootDFile.readLatest()
    // )) {
    //   const d = await this.getTopicContents(topic);
    //   console.log(`...${hash.slice(32)}`, topic, JSON.stringify(d.data));
    // }
    // console.log("================================\n\n");
  }
}
