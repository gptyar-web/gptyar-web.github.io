import {createHandler} from './index.js';
Deno.serve(createHandler(Deno.env.toObject()));
