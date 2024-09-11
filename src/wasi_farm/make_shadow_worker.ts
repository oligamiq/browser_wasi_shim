// import type { WASIFarm } from "./farm";

// let kept_farm;

// self.onmessage = (event) => {
//   const message: {
//     msg: "create" | "ref";
//     data?: unknown;
//   } = event.data;

//   if (message.msg === "create") {
//     const farm = message.data as WASIFarm;
//     kept_farm = farm;
//   } else if (message.msg === "ref") {
//     const ref = kept_farm.get_ref();
//     self.postMessage({
//       msg: "ref",
//       data: ref,
//     });
//   }
// }

// throw new Error("Not load this file!");
