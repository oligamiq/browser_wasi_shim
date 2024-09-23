
export const url = () => {
  const code = 'function _define_property(r,e,t){return e in r?Object.defineProperty(r,e,{value:t,enumerable:!0,configurable:!0,writable:!0}):r[e]=t,r}class AllocatorUseArrayBuffer{static init_self(r){return new AllocatorUseArrayBuffer(r.share_arrays_memory)}async async_write(r,e,t){let o=new Int32Array(this.share_arrays_memory);for(;;){let{value:i}=Atomics.waitAsync(o,0,1);if("timed-out"===(i instanceof Promise?await i:i))throw Error("timed-out lock");if(0===Atomics.compareExchange(o,0,0,1)){this.write_inner(r,e,t),Atomics.store(o,0,0),Atomics.notify(o,0,1);break}}}block_write(r,e,t){for(;;){let o=new Int32Array(this.share_arrays_memory);if("timed-out"===Atomics.wait(o,0,1))throw Error("timed-out lock");if(0!==Atomics.compareExchange(o,0,0,1))continue;let i=this.write_inner(r,e,t);return Atomics.store(o,0,0),Atomics.notify(o,0,1),i}}write_inner(r,e,t){let o,i;let s=new Int32Array(this.share_arrays_memory),a=new Uint8Array(this.share_arrays_memory);o=0===Atomics.add(s,1,1)?Atomics.store(s,2,12):Atomics.load(s,2);let n=this.share_arrays_memory.byteLength,c=r.byteLength,l=o+c;if(n<l)throw Error("size is bigger than memory. \\nTODO! fix memory limit. support big size another way.");if(r instanceof Uint8Array)i=r;else if(r instanceof Uint32Array){let e=new ArrayBuffer(r.byteLength);new Uint32Array(e).set(r),i=new Uint8Array(e)}a.set(new Uint8Array(i),o),Atomics.store(s,2,l);let y=new Int32Array(e);return Atomics.store(y,t,o),Atomics.store(y,t+1,c),[o,c]}free(r,e){Atomics.sub(new Int32Array(this.share_arrays_memory),1,1)}get_memory(r,e){let t=new ArrayBuffer(e);return new Uint8Array(t).set(new Uint8Array(this.share_arrays_memory).slice(r,r+e)),t}use_defined_memory(r,e,t){new Uint8Array(this.share_arrays_memory).set(new Uint8Array(t).slice(0,e),r)}get_object(){return{share_arrays_memory:this.share_arrays_memory}}constructor(r=new SharedArrayBuffer(0xa00000)){_define_property(this,"share_arrays_memory",void 0),this.share_arrays_memory=r;let e=new Int32Array(this.share_arrays_memory);Atomics.store(e,0,0),Atomics.store(e,1,0),Atomics.store(e,2,12)}}console.log("worker_background_worker");let WorkerBackground=class{assign_worker_id(){for(let r=0;r<this.workers.length;r++)if(void 0===this.workers[r])return r;return this.workers.push(void 0),this.workers.length}ref(){return{allocator:this.allocator.get_object(),lock:this.lock,signature_input:this.signature_input}}async listen(){let r=new Int32Array(this.lock);Atomics.store(r,0,0),Atomics.store(r,1,0);let e=new Int32Array(this.signature_input);for(;;)try{let t;let{value:o}=Atomics.waitAsync(r,1,0);if(t=o instanceof Promise?await o:o,"timed-out"===t)throw Error("timed-out");let i=Atomics.load(r,1);if(1!==i)throw Error("locked");let s=Atomics.load(e,0);r:if(1===s){let r=Atomics.load(e,1),t=Atomics.load(e,2),o=this.allocator.get_memory(r,t),i=new TextDecoder().decode(o),s=1===Atomics.load(e,3),a=new Worker(i,{type:s?"module":"classic"}),n=Atomics.load(e,4),c=Atomics.load(e,5),l=this.allocator.get_memory(n,c),y=new TextDecoder().decode(l),m=JSON.parse(y),h=this.assign_worker_id();this.workers[h]=a;let{promise:_,resolve:d}=Promise.withResolvers();a.onmessage=r=>{let{msg:e}=r.data;"ready"===e&&(console.log("worker ready"),d()),"done"===e&&(this.workers[h].terminate(),this.workers[h]=void 0)},a.postMessage({...this.override_object,...m,worker_id:h,worker_background_ref:this.ref()}),await _,Atomics.store(e,0,h);break r}let a=Atomics.exchange(r,1,0);if(1!==a)throw Error("Lock is already set");let n=Atomics.notify(r,1,1);if(1!==n){if(0===n){console.warn("notify failed, waiter is late");continue}throw Error("notify failed: "+n)}}catch(r){console.error(r)}}constructor(r){_define_property(this,"override_object",void 0),_define_property(this,"allocator",void 0),_define_property(this,"lock",void 0),_define_property(this,"signature_input",void 0),_define_property(this,"workers",[]),_define_property(this,"listen_holder",void 0),this.override_object=r,this.lock=new SharedArrayBuffer(8),this.allocator=new AllocatorUseArrayBuffer(new SharedArrayBuffer(10240)),this.signature_input=new SharedArrayBuffer(24),this.listen_holder=this.listen()}};console.log("worker_background_worker end"),globalThis.onmessage=r=>{let{override_object:e}=r.data;postMessage(new WorkerBackground(e).ref())};';

  const blob = new Blob([code], { type: "application/javascript" });

  const url = URL.createObjectURL(blob);

  return url;
}