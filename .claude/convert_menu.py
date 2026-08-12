# -*- coding: utf-8 -*-
import io, sys

log = io.open('.claude/convert_result.txt', 'w', encoding='utf-8')

def patch(path, replacements):
    src = io.open(path, encoding='utf-8').read()
    for old, new in replacements:
        if old not in src:
            log.write('MISSING in %s: %r\n' % (path, old[:50]))
            return
        src = src.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(src)
    log.write('OK %s\n' % path)

patch('src/app/dashboard/menu/menu-manager.tsx', [
    ('import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";',
     'import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";\nimport { SearchableSelect } from "@/components/ui/searchable-select";'),
    (u'''        <Field label="دسته">
          <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
            <option value="">دسته را انتخاب کنید…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>''',
     u'''        <Field label="دسته">
          <SearchableSelect
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: "", label: "دسته را انتخاب کنید…" },
              ...activeCategories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>'''),
    (u'''        <Field label="دسته">
          <select className={inputClass} value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>
            <option value="">دسته را انتخاب کنید…</option>
            {selectableCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>''',
     u'''        <Field label="دسته">
          <SearchableSelect
            value={categoryId}
            onChange={(v) => setCategoryId(v)}
            options={[
              { value: "", label: "دسته را انتخاب کنید…" },
              ...selectableCategories.map((category) => ({ value: category.id, label: category.name })),
            ]}
          />
        </Field>'''),
])
log.close()
