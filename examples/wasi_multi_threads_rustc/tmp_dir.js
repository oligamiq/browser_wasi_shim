import {
	PreopenDirectory,
	WASIFarm,
	File,
	Directory,
	Fd,
} from "../../dist/index.js";

const { promise, resolve } = Promise.withResolvers();
import("../node_modules/@oligami/shared-object/dist/index.js").then(resolve);

const root_dir = new PreopenDirectory("/", [
	[
		"hello.rs",
		new File(
			new TextEncoder("utf-8").encode(
				`fn main() { println!("Hello World!"); }`,
			),
		),
	],
	["sysroot", new Directory([])],
	["sysroot-with-lld", new Directory([])],
	["tmp", new Directory([])],
	["lib", new Directory([])],
	["bin", new Directory([["rustc.wasm", new File(new Uint8Array())]])],
	[
		"home",
		new Directory([
			[
				"wasi",
				new Directory([
					[
						".cargo",
						new Directory([
							[
								"bin",
								new Directory([["cargo.wasm", new File(new Uint8Array())]]),
							],
						]),
					],
				]),
			],
		]),
	],
	["cargo", new File(new TextEncoder("utf-8").encode(""))],
	["rustc.wasm", new File(new Uint8Array())],
]);

class DevUrandom extends Directory {
	// fd_read(size: number): {
	// 	ret: number;
	// 	data: Uint8Array;
	// };
	fd_read(size) {
		const data = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			data[i] = Math.floor(Math.random() * 256);
		}

		return {
			ret: 0,
			data,
		};
	}
}

const farm = new WASIFarm(undefined, undefined, undefined, [
	// new PreopenDirectory(".", [
	// 	["tmp-tmp", new File(new TextEncoder("utf-8").encode("Hello World!"))],
	// 	["tmp-dir", new Directory([])],
	// ]),
	// new PreopenDirectory("tmp-dir", [
	// 	[
	// 		"tmp-dir_inner",
	// 		new Directory([
	// 			[
	// 				"tmp-dir_inner-file",
	// 				new File(new TextEncoder("utf-8").encode("Hello World!!!!!")),
	// 			],
	// 		]),
	// 	],
	// ]),
	new PreopenDirectory("/tmp", []),
	new PreopenDirectory("/dev", [["urandom", new DevUrandom()]]),
	root_dir,
	new PreopenDirectory("~", [
		[
			"####.rs",
			new File(
				new TextEncoder("utf-8").encode(
					`fn main() { println!("Hello World!"); }`,
				),
			),
		],
		["sysroot", new Directory([])],
	]),
]);

const ret = await farm.get_ref();

await promise;

const shared = new SharedObject.SharedObject(
	{
		get_file(path_str) {
			console.log(root_dir);
			const path = {
				parts: [path_str],
				is_dir: false,
			};
			const { ret, entry } = root_dir.dir.get_entry_for_path(path);
			if (ret !== 0) {
				throw new Error(`get_file: ${path_str} failed`);
			}
			return entry.data;
		},
	},
	"root_dir",
);

postMessage({ wasi_ref: ret });
