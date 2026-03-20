"use strict";

function convertBoxTagSyntax(content) {
  if (!content) return content;

  const openTagRegex = /\{\$\s*box(?:\s+([^$}]*?))?\s*\$\}/gi;
  const closeTagRegex = /\{\$\s*endbox\s*\$\}/gi;

  const convertedOpen = content.replace(openTagRegex, (_, rawArgs) => {
    const args = (rawArgs || "").trim();
    return args ? `{% box ${args} %}` : "{% box %}";
  });

  return convertedOpen.replace(closeTagRegex, "{% endbox %}");
}

hexo.extend.filter.register(
  "before_post_render",
  function (data) {
    data.content = convertBoxTagSyntax(data.content);
    return data;
  },
  3,
);