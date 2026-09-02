const fs = require('fs');

const path = 'src/app/dashboard/menu/menu-manager.tsx';
let content = fs.readFileSync(path, 'utf8');

const newMemo = `  // ⚡ Bolt: Extract grouping logic into a useMemo map to prevent O(N*C) operations
  // during render. Instead of filtering the whole array for every category,
  // we group them once in O(N) and do an O(1) map lookup during render.
  const itemsByCategory = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const item of filteredItems) {
      if (!item.category_id) continue;
      let arr = map.get(item.category_id);
      if (!arr) {
        arr = [];
        map.set(item.category_id, arr);
      }
      arr.push(item);
    }
    return map;
  }, [filteredItems]);

  return (`;

content = content.replace('  return (\n    <SectionCard title="آیتم‌ها">', newMemo + '\n    <SectionCard title="آیتم‌ها">');

content = content.replace('const items = filteredItems.filter((i) => i.category_id === c.id);', 'const items = itemsByCategory.get(c.id) ?? [];');

fs.writeFileSync(path, content, 'utf8');
console.log('Done!');
