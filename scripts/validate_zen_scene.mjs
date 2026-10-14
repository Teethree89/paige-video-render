// Validate exactly the same primitive document contract as the live editor.
import {readFileSync} from 'node:fs';
import {validatePrimitiveDocument} from '../primitive-schema.js';

const [path,shotId]=process.argv.slice(2);
if (!path || !shotId) {
  console.error('Usage: node scripts/validate_zen_scene.mjs <json-file> <shot-id>');
  process.exit(2);
}
try {
  const proposal=JSON.parse(readFileSync(path,'utf8'));
  const validated=validatePrimitiveDocument(proposal,[shotId]);
  if(validated.scenes.length!==1||validated.scenes[0].shotId!==shotId)
    throw Error('Output did not contain exactly one requested shot');
  if(validated.scenes[0].objects.length>16)
    throw Error('Proposal exceeds first-pass complexity budget');
  console.log('Validated scene proposal: '+shotId+', '+validated.scenes[0].objects.length+' object(s).');
}catch(error){
  console.error('AI primitive validation failed: '+error.message);
  process.exit(1);
}
