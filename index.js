document.addEventListener('DOMContentLoaded', () => {
  const inputData = document.getElementById('inputData');
  const formatSelect = document.getElementById('formatSelect');
  const convertBtn = document.getElementById('convertBtn');
  const copyBtn = document.getElementById('copyBtn');
  const output = document.getElementById('output');
  const errorMsg = document.getElementById('errorMsg');
  const detectedLabel = document.getElementById('detectedLabel');

  // --- MOTEURS DE LECTURE (Parsers) ---
  const parsers = {
    json: (str) => {
      try { return JSON.parse(str); } catch (e) { return null; }
    },
    xml: (str) => {
      if (!str.trim().startsWith('<')) return null;
      try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(str, "text/xml");
        if (xmlDoc.querySelector('parsererror')) return null;
        const xmlToObject = (node) => {
          if (node.children.length === 0) return node.textContent;
          let obj = {};
          for (let child of node.children) {
            const val = xmlToObject(child);
            if (obj[child.tagName]) {
              if (!Array.isArray(obj[child.tagName])) obj[child.tagName] = [obj[child.tagName]];
              obj[child.tagName].push(val);
            } else {
              obj[child.tagName] = val;
            }
          }
          return obj;
        };
        const root = xmlDoc.documentElement;
        const result = {};
        result[root.tagName] = xmlToObject(root);
        return result;
      } catch (e) { return null; }
    },
    query: (str) => {
      if (str.includes('\n') || !str.includes('=')) return null;
      try {
        const params = new URLSearchParams(str.trim().replace(/^\?/, ''));
        const obj = {};
        let hasKeys = false;
        for (const [k, v] of params.entries()) {
          obj[k] = v;
          hasKeys = true;
        }
        return hasKeys ? obj : null;
      } catch (e) { return null; }
    },
    env: (str) => {
      if (!str.includes('=')) return null;
      const lines = str.split('\n');
      const obj = {};
      let isEnv = false;
      lines.forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
        if (match) {
          isEnv = true;
          let val = match[2].trim().replace(/^["']|["']$/g, ''); 
          obj[match[1]] = val;
        }
      });
      return isEnv && !str.includes('[') && !str.includes('{') ? obj : null;
    }
  };

  const autodetectFormat = (str) => {
    str = str.trim();
    if (!str) return { type: null, data: null };
    let data = parsers.json(str); if (data) return { type: 'json', data };
    data = parsers.xml(str); if (data) return { type: 'xml', data };
    data = parsers.query(str); if (data) return { type: 'query string', data };
    data = parsers.env(str); if (data) return { type: '.env', data };
    return { type: 'text', data: null };
  };

  // --- MOTEURS D'ÉCRITURE (Converters) ---
  const converters = {
    json: (obj) => JSON.stringify(obj, null, 4),
    
    env: (obj) => {
      let res = "";
      for (const [k, v] of Object.entries(obj)) {
        res += (typeof v === 'object' && v !== null) ? `${k.toUpperCase()}='${JSON.stringify(v)}'\n` : `${k.toUpperCase()}="${v}"\n`;
      }
      return res.trim();
    },

    query: (obj) => {
      const flat = {};
      for (const [k, v] of Object.entries(obj)) {
        flat[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
      }
      return new URLSearchParams(flat).toString();
    },

    yaml: (obj, indent = 0) => {
      let res = '';
      const s = '  '.repeat(indent);
      for (const [k, v] of Object.entries(obj)) {
        if (v === null) {
          res += `${s}${k}: null\n`;
        } else if (typeof v === 'object' && !Array.isArray(v)) {
          res += `${s}${k}:\n${converters.yaml(v, indent + 1)}`;
        } else if (Array.isArray(v)) {
          res += `${s}${k}:\n`;
          v.forEach(i => {
            if (typeof i === 'object' && i !== null) {
              const row = converters.yaml(i, indent + 2);
              res += row.replace(new RegExp(`^\\s{${(indent+2)*2}}`), `${s}  - `);
            } else {
              res += `${s}  - ${JSON.stringify(i)}\n`;
            }
          });
        } else {
          res += `${s}${k}: ${typeof v === 'string' ? `"${v}"` : v}\n`;
        }
      }
      return res;
    },

    toml: (obj, prefix = '') => {
      let keys = '';
      let tables = '';
      
      // On sépare le contenu : valeurs simples vs sous-objets
      const entries = Object.entries(obj);
      const hasSimpleValues = entries.some(([k, v]) => typeof v !== 'object' || v === null || (Array.isArray(v) && (v.length === 0 || typeof v[0] !== 'object')));

      for (const [k, v] of entries) {
        if (v === null) continue;

        if (typeof v === 'object' && !Array.isArray(v)) {
          const sectionName = prefix ? `${prefix}.${k}` : k;
          const subContent = converters.toml(v, sectionName);
          
          if (subContent.trim()) {
            // Si le contenu généré contient des clés (=), on l'ajoute avec son header
            if (subContent.includes('=') && !subContent.trim().startsWith('[')) {
              tables += `\n[${sectionName}]\n${subContent}\n`;
            } else {
              // Sinon c'est juste un passage vers une table plus profonde, on ne met pas de header vide
              tables += `\n${subContent}`;
            }
          }
        } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
          // Tableaux d'objets [[table]]
          v.forEach(item => {
            const sectionName = prefix ? `${prefix}.${k}` : k;
            tables += `\n[[${sectionName}]]\n${converters.toml(item, sectionName)}\n`;
          });
        } else {
          // Valeurs simples (doivent être en haut de section)
          keys += `${k} = ${JSON.stringify(v)}\n`;
        }
      }
      return (keys + tables).trim();
    },

    xml: (obj, indent = 1) => {
      if (indent === 1) {
        const rootTag = Object.keys(obj).length === 1 ? Object.keys(obj)[0] : 'root';
        const data = Object.keys(obj).length === 1 ? Object.values(obj)[0] : obj;
        return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${converters.xml(data, 2)}</${rootTag}>`;
      }
      let x = '';
      const s = '  '.repeat(indent - 1);
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          x += `${s}<${k}>\n${converters.xml(v, indent + 1)}${s}</${k}>\n`;
        } else if (Array.isArray(v)) {
          v.forEach(i => {
            x += (typeof i === 'object') ? `${s}<${k}>\n${converters.xml(i, indent + 1)}${s}</${k}>\n` : `${s}<${k}>${i}</${k}>\n`;
          });
        } else {
          x += `${s}<${k}>${v}</${k}>\n`;
        }
      }
      return x;
    }
  };

  // --- UI LOGIC ---
  const autoExpand = (el) => {
    el.style.height = 'auto'; 
    el.style.height = (el.scrollHeight) + 'px';
  };

  inputData.addEventListener('input', () => {
    autoExpand(inputData);
    if (!inputData.value.trim()) {
      copyBtn.style.display = 'none';
      output.value = '';
      detectedLabel.style.display = 'none';
    }
  });

  convertBtn.addEventListener('click', () => {
    errorMsg.style.display = 'none';
    detectedLabel.style.display = 'none';
    copyBtn.style.display = 'none';
    output.value = '';

    const raw = inputData.value.trim();
    if (!raw) return;

    const { type, data } = autodetectFormat(raw);
    const finalData = data || (parsers.json(raw)); // Fallback au JSON si détection texte

    if (!finalData) { errorMsg.style.display = 'inline-block'; return; }

    detectedLabel.innerText = `DETECTED: ${type === 'text' ? 'json' : type}`;
    detectedLabel.style.display = 'inline-block';

    try {
      const targetFormat = formatSelect.value;
      const result = converters[targetFormat](finalData);
      output.value = result;
      copyBtn.style.display = 'flex';
      
      setTimeout(() => { 
        autoExpand(inputData); 
        autoExpand(output); 
      }, 50);
    } catch (e) { 
      errorMsg.innerText = "CONVERSION ERROR"; 
      errorMsg.style.display = 'inline-block'; 
    }
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(output.value).then(() => {
      const btnSpan = document.getElementById('copyBtnText');
      const old = btnSpan.innerText;
      btnSpan.innerText = 'COPIED!';
      copyBtn.classList.add('success');
      setTimeout(() => { 
        btnSpan.innerText = old; 
        copyBtn.classList.remove('success'); 
      }, 2000);
    });
  });
});