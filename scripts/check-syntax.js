const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function findJsFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findJsFiles(filePath, fileList);
    } else if (filePath.endsWith('.js')) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

function checkSyntax() {
  const dirsToCheck = ['src', 'test', 'scripts'];
  const jsFiles = [];

  for (const dir of dirsToCheck) {
    const dirPath = path.join(process.cwd(), dir);
    findJsFiles(dirPath, jsFiles);
  }

  console.log(`Encontrados ${jsFiles.length} ficheiros JS para verificação de sintaxe.`);

  let hasErrors = false;

  for (const file of jsFiles) {
    try {
      execSync(`node -c "${file}"`, { stdio: 'ignore' });
    } catch (error) {
      console.error(`❌ Erro de sintaxe em: ${file}`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('Falha na verificação de sintaxe.');
    process.exit(1);
  } else {
    console.log('✅ Verificação de sintaxe concluída com sucesso. Sem erros.');
    process.exit(0);
  }
}

checkSyntax();
