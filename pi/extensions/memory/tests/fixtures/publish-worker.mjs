import { resolveProject } from '../../src/project.ts';
import { Store } from '../../src/store.ts';
import { stageGeneration } from '../../src/publication.ts';

const root = process.argv[2];
const store = await Store.open(root,resolveProject(root));
const limits = { maxJobsPerDay:20,maxInputEstimatedTokensPerDay:200000,maxOutputTokensPerDay:40000 };
const task = store.reserveConsolidation('child-worker',limits);
if (!task) { process.stdout.write('unavailable\n'); process.exit(0); }
const manifest = stageGeneration(root,resolveProject(root),task.epoch,task.revision,task.claims,[{ heading:'Facts',items:[{text:task.claims[0].text,claimIds:[task.claims[0].id]}] }]);
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  try { process.stdout.write(`${store.publish(task,manifest)}\n`); }
  catch { process.stdout.write('failed\n'); }
  finally { store.close(); }
});
