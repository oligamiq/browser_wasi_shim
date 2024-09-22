// If you create a worker and try to increase the number of threads,
// you will have to use Atomics.wait because they need to be synchronized.
// However, this is essentially impossible because Atomics.wait blocks the threads.
// Therefore, a dedicated worker that creates a subworker (worker in worker) is prepared.
// The request is made using BroadcastChannel.

class WorkerBackground {
  private random_id: string;
  private bc: BroadcastChannel;
  private workers: Map<string, Worker>;

  constructor() {
    this.random_id = Math.random().toString(36).slice(-8);
  }

  listen(): void {
    this.bc = new BroadcastChannel(`worker_background_${this.random_id}`);
    this.bc.onmessage = (e: MessageEvent) => {
      if (e.data.worker_url) {
        this.create_worker(e);
        return;
      }
      const { id, data }: {
        id: string;
        data: unknown;
      } = e.data;
      const worker = this.workers.get(id);
      if (!worker) {
        return;
      }
      worker.postMessage(data);
    }
  }

  create_worker(e: MessageEvent): void {
    const { worker_url, worker_option, id }: {
      worker_url: string;
      worker_option: WorkerOptions;
      id: string;
    } = e.data;
    const worker = new Worker(worker_url, worker_option);
    this.workers.set(id, worker);
    worker.onmessage = (e) => {
      this.bc.postMessage({ id, data: e.data });
    };
  }

  ref(): string {
    return this.random_id;
  }
}

const worker_b = new WorkerBackground();
postMessage(worker_b.ref());
