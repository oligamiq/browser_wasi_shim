const code = `let kept_farm;self.onmessage=event=>{const message=event.data;if(message.msg==="create"){const farm=message.data;kept_farm=farm}else if(message.msg==="ref"){const ref=kept_farm.get_ref();self.postMessage({msg:"ref",data:ref})}};`
export const make_shadow_worker_blob_url = () => {
    const blob = new Blob([code], { type: "application/javascript" });
    return URL.createObjectURL(blob);
}
