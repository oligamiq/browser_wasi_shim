import { debug } from "./debug.js";
import { Fd } from "./fd.js";
import WASI, { Options } from "./wasi.js";

interface Channel {
  postMessage: (message: any) => void | Promise<void>;
  onmessage: (message: any) => void | Promise<void>;
}

export default class WASIFarm {
  args: Array<string>;
  env: Array<string>;
  fds: Array<Fd>;
  sockets: WASIFarmSocketReceiver[];

  constructor(
    args: Array<string>,
    env: Array<string>,
    fds: Array<Fd>,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    this.args = args;
    this.env = env;
    this.fds = fds;
    this.sockets = [];
  }

  member_ref(): [Array<string>, Array<string>, Array<Fd>] {
    const args = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("args", prop);
        return this.args[prop];
      }
    });
    const env = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("env", prop);
        return this.env[prop];
      }
    });
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }
        return this.fds[prop];
      }
    });

    return [args, env, fds];
  }

  get_ref(): [WASIFarmRef, (socket: Channel) => void] {
    let socket = new WASIFarmSocketPark(this.member_ref());

    return [new WASIFarmRef(
      socket.socket_(),
    ), socket.register];
  }
}

type Message = {
  id: number;
  movement: number;
  props: any;
  kind: "method" | "getter" | "setter";
  args: any[];
}

export class WASIFarmSocketPark {
  socket: SharedArrayBuffer[];
  objects: any[];
  queue: Message[];
  channel: Channel;

  constructor(
    objects: any[],
  ) {
    for (const object of objects) {
      let array: SharedArrayBuffer;
      if (object instanceof Array) {
        array = new SharedArrayBuffer(8 * 2 + object.length * 8);
      } else {
        array = new SharedArrayBuffer(8 * 2);
      }
      let view = new Int32Array(array);
      view[0] = -1;
      this.socket.push(array);
    }
    this.objects = objects;
  }

  socket_() {
    return this.socket;
  }

  register(
    channel: Channel,
  ) {
    this.channel = channel;
    this.channel.onmessage = (message: Message) => {
      this.queue.push(message);
    };
  }

  observer(
    socket: Channel,
  ) {

  }

  async observe_array(
    socket: Channel,
    id: number,
    array: any,
  ) {
    const bufferView = new Int32Array(this.socket[id]);

    while (true) {
      let { value } = Atomics.waitAsync(bufferView, 0, -1);
      let ret: "not-equal" | "timed-out" | "ok";
      if (value instanceof Promise) {
        ret = await value;
      } else {
        ret = value;
      }
      try {
        if (ret === "ok" || ret === "not-equal") {
          const movement = bufferView[0];
          if (movement === -1) {
            throw new Error("movement is -1");
          } else if (movement === -2) {
            // Arrayそのものを操作する

            let result;

            try {
              const old_queue = this.queue;
              const old = Atomics.exchange(bufferView, 1, -2);
              const observer_num = Atomics.notify(bufferView, 1);
              if (observer_num !== 1) {
                throw new Error("observer_num is not 1");
              }
              if (old !== 0) {
                throw new Error("old is not 0");
              }
              const ret = Atomics.wait(bufferView, 0, -2);
              if (ret !== "ok" && ret !== "not-equal") {
                throw new Error("timeout");
              }

              // queueから取り出す
              // 5s以内にqueueに増えなければ、timeout
              const start = Date.now();
              let messages: Message[];
              while (true) {
                messages = this.queue.filter((message) => message.id === id && message.movement === movement);
                if (messages.length > 0) {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
                if (Date.now() - start > 5000) {
                  throw new Error("timeout");
                }
              }

              let message: Message;
              if (messages.length === 0) {
                throw new Error("message is not found");
              } else if (messages.length > 1) {
                // 古いmessageは無視する
                message = messages[messages.length - 1];
                this.queue = this.queue.filter((message) => !(message.id === id && message.movement === movement));
              } else {
                message = messages[0];
              }

              // messageを処理する
              if (message === undefined) {
                throw new Error("message is undefined");
              }
              const props = message.props;
              const args = message.args;
              const kind = message.kind;
              if (props === undefined) {
                throw new Error("props is undefined");
              }
              if (args === undefined) {
                throw new Error("args is undefined");
              }
              if (kind === undefined) {
                throw new Error("kind is undefined");
              }

              // 処理する
              if (kind === "method") {
                const ret = array[props](...args);
                if (ret instanceof Promise) {
                  result = await ret;
                }
              } else if (kind === "getter") {
                const ret = array[props];
                if (ret instanceof Promise) {
                  result = await ret;
                }
              } else if (kind === "setter") {
                if (args.length !== 1) {
                  throw new Error("args.length is not 1");
                }

                array[props] = args[0];
              } else {
                throw new Error("kind is invalid");
              }
            } catch (e) {
              result = e;
            }
            // 結果を返す
            socket.postMessage(result);

            // 通知する
            bufferView[0] = 0;
            Atomics.notify(bufferView, 0);

            bufferView[1] = 0;
          } else if (movement >= 0) {
            // Arrayの要素を操作する
          } else {
            throw new Error("movement is invalid");
          }
        } else if (ret === "timed-out") {
          throw new Error("timeout");
        }
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class WASIFarmRef {
  socket: SharedArrayBuffer[];

  constructor(socket: SharedArrayBuffer[]) {
    this.socket = socket;
  }

  get_wasi(): WASI {
    const args = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("args", prop);
        return this.args[prop];
      }
    });
    const env = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("env", prop);
        return this.env[prop];
      }
    });
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }
        return this.fds[prop];
      }
    });

    return new WASI(args, env, fds);
  }
}
