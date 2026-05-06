// @ts-expect-error
import worker_background_worker from "../../../threads/src/shared_array_buffer/worker_background/worker_background_worker_minify.js";
import { wait_async_polyfill } from "../../src";

wait_async_polyfill();

worker_background_worker();
