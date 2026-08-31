import worker from '../../../worker';
import type { Env } from '../../../worker/types';

export const onRequest: PagesFunction<Env> = ({ request, env }) => worker.fetch(request, env);
