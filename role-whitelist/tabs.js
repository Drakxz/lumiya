// Resolve boundaries before filtering: hiding a separator must never merge tabs.
const isSeparator = role => /^[\s\-‐‑‒–—―─━_=]{5,}$/u.test(role.name);

function roleTabs(roles, visible, pageSize = 7) {
  const groups = [];
  let group = [];
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
  };
  for (const role of roles) {
    if (isSeparator(role)) flush();
    else group.push(role);
  }
  flush();
  const pages = [];
  groups.forEach((roles, index) => {
    const filtered = roles.filter(role => visible.has(role.id));
    const total = Math.ceil(filtered.length / pageSize);
    for (let n = 0; n < total; n++) {
      pages.push({
        label: `Aba ${index + 1}${total > 1 ? ` · ${n + 1}/${total}` : ""}`,
        roles: filtered.slice(n * pageSize, (n + 1) * pageSize)
      });
    }
  });
  return pages;
}

module.exports = { roleTabs, isSeparator };
