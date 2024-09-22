export class WorkerBackgroundRef {
  private random_id: string;
  private bc: BroadcastChannel;

  constructor(random_id: string) {
    this.random_id = random_id;
    this.bc = new BroadcastChannel(`worker_background_${this.random_id}`);
  }

  worker(
    url: string,
    options?: WorkerOptions,
  ): WorkerRef {
    const id = Math.random().toString(36).slice(-8);
    this.bc.postMessage({
      worker_url: url,
      worker_option: options,
      id,
    });
    console.log("worker", id);
    return new WorkerRef(id);
  }
}

export class WorkerRef {
  private bc: BroadcastChannel;
  private id: string;
  onmessage: (e: {
    data: unknown;
  }) => void;

  constructor(id: string) {
    this.id = id;
    this.bc = new BroadcastChannel(`worker_background_${this.id}`);

    this.bc.onmessage = (e: MessageEvent) => {
      const { id, data }: {
        id: string;
        data: unknown;
      } = e.data;

      if (id !== this.id) {
        return;
      }

      this.onmessage({ data });
    };
  }

  postMessage(data: unknown): void {
    this.bc.postMessage({
      id: this.id,
      data,
    });
  }
}
