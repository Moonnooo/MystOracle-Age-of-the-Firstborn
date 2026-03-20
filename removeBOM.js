const fs = require('fs');
['package.json'].forEach(f => {
  if(fs.existsSync(f)){
    let data = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    fs.writeFileSync(f, data, 'utf8');
  }
});
