const code = `
function _define_property(obj,key,value){if(key in obj){Object.defineProperty(obj,key,{value:value,enumerable:true,configurable:true,writable:true})}else{obj[key]=value}return obj}let WorkerBackground=class WorkerBackground{listen(){this.bc=new BroadcastChannel(\`worker_background_\${this.random_id}\`);this.bc.onmessage=e=>{if(e.data.worker_url){this.create_worker(e);return}const{id,data}=e.data;const worker=this.workers.get(id);if(!worker){return}worker.postMessage(data)}}create_worker(e){const{worker_url,worker_option,id}=e.data;const worker=new Worker(worker_url,worker_option);this.workers.set(id,worker);worker.onmessage=e=>{this.bc.postMessage({id,data:e.data})}}ref(){return this.random_id}constructor(){_define_property(this,"random_id",void 0);_define_property(this,"bc",void 0);_define_property(this,"workers",void 0);this.random_id=Math.random().toString(36).slice(-8)}};const worker_b=new WorkerBackground;postMessage(worker_b.ref());
//# sourceMappingURL=worker.js.map`;

const blob = new Blob([code], { type: "application/javascript" });

const url = URL.createObjectURL(blob);

export const worker = new Worker(url);
