function fetchWithTimeout(url, timeout = 3000) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), timeout)
    ),
  ]);
}

function parseBibtexFunc(bibtexContent) {
  let parsedBibtex = {};
  let entryTypeCitationKeyRegex = /^@(\w+)\{([^,]+),/;
  // 分割Bibtex条目到数组中
  let lines = bibtexContent.split("\n");

  // 处理entryType和citationKey
  let citationKeyMatch = entryTypeCitationKeyRegex.exec(bibtexContent);
  if (citationKeyMatch) {
    parsedBibtex["entryType"] = citationKeyMatch[1].trim();
    parsedBibtex["citationKey"] = citationKeyMatch[2].trim();
  }

  // 遍历其余行
  let line_i = 1;
  while (line_i < lines.length) {
    line = lines[line_i];
    if (line) {
      let parts = line.split("=");
      if (parts.length === 2) {
        let key = parts[0].trim();
        let value = parts[1].trim();
        parsedBibtex[key] = "";
        // 如果value不是以'},'或'}'结尾，则继续读取下一行
        while (value && !value.match(/},?$/)) {
          // 清除值两边的空格
          if (value) {
            // 非首行添加空格
            if (parsedBibtex[key] != "") {
              parsedBibtex[key] += " ";
            }
            // 将新行添加到value中
            parsedBibtex[key] += value.trim();
          }
          line_i++;
          value = lines[line_i].trim();
        }
        // 清除值两边的{}和逗号
        parsedBibtex[key] += value;
        parsedBibtex[key] = parsedBibtex[key]
          .replace(/^\s*{\s*/, "")
          .replace(/\s*},?$/, "");
        //   return parsedBibtex[key];
      }
    }
    line_i++;
  }
  return parsedBibtex;
}

var zoteroPane = Zotero.getActiveZoteroPane();
var items = zoteroPane.getSelectedItems();
var library = zoteroPane.getSelectedLibraryID();

if (items.length == 0) {
  return "未选择任何条目";
}

var unavailableItems = [];

for (let item of items) {
  var title = String(item.getField("title"));
  if (Zotero.ItemTypes.getName(item.itemTypeID) == "computerProgram") {
    // 文献类型为软件时跳过
    continue;
  }

  const searchUrl = `https://dblp.org/search?q=${encodeURIComponent(title)}`;

  const isSuccess = await fetchWithTimeout(searchUrl)
    .then(async (searchHtml) => {
      // 处理响应
      searchHtml = await searchHtml.text();

      // 使用 DOMParser 解析 HTML 字符串
      const parser = new DOMParser();
      const doc = parser.parseFromString(searchHtml, "text/html");

      // 查找第一个条目的 BibTeX 链接
      const firstEntryBibtexLink = doc.querySelector(
        'li.entry.inproceedings .drop-down .body a[href*="?view=bibtex"]'
      );

      // return firstEntryBibtexLink;
      if (firstEntryBibtexLink) {
        const bibtexHtmlLink = firstEntryBibtexLink.href;

        // 将 BibTex 网页链接直接转换成文件链接
        let bibtexLink = bibtexHtmlLink.replace(".html?view=bibtex", ".bib");

        // 访问 BibTex 链接并获取 BibTex 内容
        const response = await fetchWithTimeout(bibtexLink)
          .then(async (bibtexContent) => {
            // 处理响应
            bibtexContent = await bibtexContent.text();

            // 解析 BibTeX
            let parsedBibtex = parseBibtexFunc(bibtexContent);
            if (!parsedBibtex.entryType) {
              return parsedBibtex;
            }

            // 更新 Zotero 条目
            // 定义 BibTeX 类型到 Zotero 类型的映射
            const typeMapping = {
              inproceedings: "conferencePaper",
              article: "journalArticle",
              book: "book",
              // ... 可以根据需要添加更多的映射 ...
            };

            try {
              // 检查 Zotero 条目的类型是否与 BibTeX 类型匹配
              let newItemType = typeMapping[parsedBibtex.entryType];
              let newItemTypeID = Zotero.ItemTypes.getID(newItemType);
              if (newItemTypeID !== item.getType()) {
                // 类型修改是被禁用的，所以这里需要创建一个新条目来更新对应的 BibTeX 信息
                // item.setType(newItemTypeID);
                let newItem = new Zotero.Item(newItemType);

                // 将新条目设置在与旧条目相同的文库中
                newItem.setField("libraryID", item.libraryID);
                // 将新条目移动到与旧条目相同的集合中
                newItem.setCollections(item.getCollections());

                // 获取新条目类型支持的所有字段
                let itemTypeFields =
                  Zotero.ItemFields.getItemTypeFields(newItemTypeID);
                let fieldName, value;

                for (let fieldID of itemTypeFields) {
                  fieldName = Zotero.ItemFields.getName(fieldID);

                  // 检查旧条目是否有这个字段，如果有，复制其值到新条目
                  if (item.getField(fieldName)) {
                    value = item.getField(fieldName);
                    if (value) {
                      newItem.setField(fieldName, value);
                    }
                  }
                }

                // 特别处理作者信息
                let creators = item.getCreators();
                newItem.setCreators(creators);

                // 特别处理 tags 信息
                let tags = item.getTags();
                newItem.setTags(tags);

                // 保存新条目
                let newItemID = await newItem.saveTx();

                // 获取并移动附件
                let attachmentIDs = item.getAttachments();
                try {
                  for (let attachmentID of attachmentIDs) {
                    let attachment = Zotero.Items.get(attachmentID);
                    // return attachment.parentItem;
                    // 更改附件的父条目
                    attachment.parentID = newItemID;
                    // return typeof(attachment);
                    await attachment.saveTx();
                  }
                } catch (error) {
                  throw new Error(error);
                }

                await newItem.saveTx();

                // 用 BibTeX 条目的内容更新新条目，而不是旧条目
                item = newItem;
              }
            } catch (error) {
              throw new Error(error);
            }

            // 定义字段映射：BibTeX字段 -> Zotero字段
            const fieldMapping = {
              creators: "creators", // 特殊处理creators
              // title: "title",
              booktitle: "publicationTitle",
              journal: "publicationTitle",
              year: "date",
              month: "date", // 与年份结合处理
              publisher: "publisher",
              volume: "volume",
              number: "issue",
              pages: "pages",
              doi: "DOI",
              url: "url",
              isbn: "ISBN",
              issn: "ISSN",
              series: "seriesTitle",
              address: "place", // 出版地
              edition: "edition",
              chapter: "section",
              school: "university", // 学校，用于论文
              institution: "institution", // 研究机构
              type: "type", // 类型
              note: "extra", // 备注信息
              keywords: "tags", // 关键词
              abstract: "abstractNote", // 摘要
              timestamp: "accessDate",
              // ... 其他字段映射
            };

            // 更新 Zotero 条目的指定字段
            for (let bibtexField in parsedBibtex) {
              let zoteroField = fieldMapping[bibtexField];

              if (zoteroField) {
                if (zoteroField === "creators") {
                  // 特殊处理作者和编辑字段(creators)
                  item.setCreators(parsedBibtex[bibtexField]);
                } else if (zoteroField === "tags") {
                  // 关键词可能需要特殊处理
                  let tags = parsedBibtex[bibtexField]
                    .split(",")
                    .map((tag) => ({ tag: tag.trim() }));
                  item.setTags(tags);
                } else {
                  try {
                    // 如果原有信息不为空，则不覆盖
                    if (item.getField(zoteroField)) {
                      continue;
                    }
                    item.setField(zoteroField, parsedBibtex[bibtexField]);
                  } catch (error) {
                    throw new Error(error);
                  }
                }
              }
            }

            await item.saveTx();

            return true;
          })
          .catch((error) => {
            // 处理错误（包括超时）
            return "BibTeX 链接请求超时！";
          });
        if (response != true) {
          return response;
        }
      } else {
        return "未找到 BibTeX 链接！";
      }
      return true;
    })
    .catch((error) => {
      // 返回错误信息

      return "搜索链接请求超时！";
    });

  if (isSuccess != true) {
    unavailableItems.push([item, isSuccess]);
    continue;
  }
}

if (unavailableItems.length > 0) {
  let message = "以下条目无法更新，可能是因为网络原因或 dblp 里没收录：\n";
  for (let item of unavailableItems) {
    message += "[ERROR " + item[1].toString() + "] " + item[0].getField("title") + "\n";
  }
  return message;
}

return true;
