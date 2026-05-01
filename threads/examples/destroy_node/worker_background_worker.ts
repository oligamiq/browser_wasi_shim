// @ts-ignore
import worker_background_worker from "../../src/shared_array_buffer/worker_background/worker_background_worker_minify.js";

import { set_fake_worker } from "./common.ts";

set_fake_worker();

worker_background_worker();
