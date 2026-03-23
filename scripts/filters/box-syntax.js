"use strict";

function convertBoxTagSyntax(content) {
  if (!content) return content;

  // Convert box tags and tolerate `${$ ... $}` when they are attached to
  // a math delimiter. Keep that leading `$` in output so MathJax delimiters
  // remain balanced, e.g. `$x^{-1}${$ endbox $}` -> `$x^{-1}$ {% endbox %}`.
  const openTagRegex = /(\$?)\{\$\s*box(?:\s+([^$}]*?))?\s*\$\}/gi;
  const closeTagRegex = /(\$?)\{\$\s*endbox\s*\$\}/gi;

  const convertedOpen = content.replace(openTagRegex, (_, leadingDollar, rawArgs) => {
    const args = (rawArgs || "").trim();
    const tag = args ? `{% box ${args} %}` : "{% box %}";
    return `${leadingDollar || ""}${tag}`;
  });

  return convertedOpen.replace(
    closeTagRegex,
    (_, leadingDollar) => `${leadingDollar || ""}{% endbox %}`,
  );
}

hexo.extend.filter.register(
  "before_post_render",
  function (data) {
    data.content = convertBoxTagSyntax(data.content);
    return data;
  },
  3,
);