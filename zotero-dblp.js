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

  // 遍历其余行
  let line_i = 1;
  while (line_i < lines.length) {
    line = lines[line_i];
    if (line) {
      let parts = line.split("=");
      if (parts.length === 2) {
        let key = parts[0].trim();
        let value = parts[1].trim();
        let leftBraceCount = value.split("{").length - 1;
        let rightBraceCount = value.split("}").length - 1;
        parsedBibtex[key] = "";
        // 如果value不是以'},'或'}'结尾，则继续读取下一行
        while (leftBraceCount != rightBraceCount) {
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
          leftBraceCount += value.split("{").length - 1;
          rightBraceCount += value.split("}").length - 1;
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

  // 从 BibTeX 字段中解析作者以及编辑
  let creators_bibtexField = ["author", "editor"];
  parsedBibtex["creators"] = [];
  for (let bibtexField of creators_bibtexField) {
    if (parsedBibtex[bibtexField]) {
      let creators = parsedBibtex[bibtexField]
        .split(" and ")
        .map((fullName) => {
          let nameParts = fullName.split(/\s+/);
          let lastName = nameParts.pop(); // 最后一个词作为姓氏
          let firstName = nameParts.join(" "); // 其余部分作为名字

          return {
            creatorType: bibtexField === "author" ? "author" : "editor",
            firstName: firstName,
            lastName: lastName,
          };
        });
      parsedBibtex["creators"] = parsedBibtex["creators"].concat(creators);
    }
  }

  // 最后处理entryType和citationKey
  let citationKeyMatch = entryTypeCitationKeyRegex.exec(bibtexContent);
  if (citationKeyMatch) {
    parsedBibtex["entryType"] = citationKeyMatch[1].trim();
    parsedBibtex["citationKey"] = citationKeyMatch[2].trim();
  }

  return parsedBibtex;
}

async function getBibtexContent(bibtexLink) {
  const response = await fetchWithTimeout(bibtexLink)
      .then(async (bibtexContent) => {
        // 处理响应
        bibtexContent = await bibtexContent.text();

        // 解析 BibTeX
        let parsedBibtex = parseBibtexFunc(bibtexContent);
        return parsedBibtex;
      }).catch((error) => {
        // 处理错误
        return "BibTeX 链接请求超时！";
      });
  return response;
}

async function findDomFromUrl(url, dom) {
  const response = await fetchWithTimeout(url)
    .then(async (searchHtml) => {
      // 处理响应
      searchHtml = await searchHtml.text();

      // 使用 DOMParser 解析 HTML 字符串
      const parser = new DOMParser();
      const doc = parser.parseFromString(searchHtml, "text/html");

      // 查找第一个条目的 dom 链接
      const firstEntryBibtexLink = doc.querySelector(dom);

      const domLink = firstEntryBibtexLink.href; // link or undefined
      if (domLink) {
        return domLink;
      } else {
        return null;
      }
    })
    .catch((error) => {
      // 处理错误（包括超时）
      return null;
    });
  return response;
}

async function createNewItem(item, newItemTypeID) {
  let newItem = new Zotero.Item(newItemTypeID);

  // 将新条目设置在与旧条目相同的文库中
  newItem.setField("libraryID", item.libraryID);
  // 将新条目移动到与旧条目相同的集合中
  newItem.setCollections(item.getCollections());

  // 获取新条目类型支持的所有字段
  let itemTypeFields = Zotero.ItemFields.getItemTypeFields(newItemTypeID);
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
    return "附件移动失败！";
  }

  await newItem.saveTx();

  return newItem;
}

function addUnavailableItem(item, message, searchUrlBaseName) {
  unavailableItems.push([item, message, searchUrlBaseName]);
}

function addAvailableItem(item, searchUrlBaseName) {
  availableItems.push([item, searchUrlBaseName]);
}

const searchUrlBases = {
  'dblp': {
    bibtex_route: [
      {
        url: "https://dblp.org/search?q=@@",
        dom: 'li.entry .drop-down .body a[href*="?view=bibtex"]',
        keyword_regex: { ".html?view=bibtex": ".bib" },
      },
    ],
  },
  'google_scholar': {
    bibtex_route: [
      {
        url: "https://scholar.google.com/scholar?q=@@/&output=cite",
        dom: "a.gs_citi", // 'div.gs_r',
        keyword_regex: {},
      },
      // {
      //   url: "info:@@:scholar.google.com/",
      //   dom: 'a.gs_citi',
      // }
    ],
  },
};

// 定义 BibTeX 类型到 Zotero 类型的映射
const typeMapping = {
  inproceedings: "conferencePaper",
  article: "journalArticle",
  book: "book",
  // ... 可以根据需要添加更多的映射 ...
};

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

async function updateItem(item, parsedBibtex, fieldMapping) {
  // 更新 Zotero 条目的指定字段
  for (let bibtexField in parsedBibtex) {
    let zoteroField = fieldMapping[bibtexField];

    if (zoteroField) {
      if (zoteroField === "creators") {
        let oldCreators = item.getCreators();
        let needAddAuthor = true;
        let needAddEditor = true;
        let newCreators = [];
        for (let c of oldCreators) {
          if (Zotero.CreatorTypes.getName(c.creatorTypeID) == "author")
            needAddAuthor = false;
          else if (Zotero.CreatorTypes.getName(c.creatorTypeID) == "editor")
            needAddEditor = false;
        }
        for (let creator of parsedBibtex[bibtexField]) {
          if ((creator.creatorType == "author" && needAddAuthor) || creator.creatorType == "editor" && needAddEditor)
            newCreators.push(creator);
        }
        // 特殊处理作者和编辑字段(creators)
        item.setCreators(newCreators);
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
          return "更新条目失败！";
        }
      }
    }
  }

  await item.saveTx();
  return true;
}

var zoteroPane = Zotero.getActiveZoteroPane();
var items = zoteroPane.getSelectedItems();
var library = zoteroPane.getSelectedLibraryID();

if (items.length == 0) {
  return "未选择任何条目";
}

var unavailableItems = [];
var availableItems = [];

for (let item of items) {
  var title = String(item.getField("title"));
  if (Zotero.ItemTypes.getName(item.itemTypeID) == "computerProgram") {
    // 文献类型为软件时跳过
    continue;
  }

  for (let searchUrlBaseName in searchUrlBases) {
    let searchUrlBase = searchUrlBases[searchUrlBaseName];
    // 支持深查找网页，获取 BibTeX 链接
    let keyword = title;
    let findError = false;
    for (let bibtex_route of searchUrlBase.bibtex_route) {
      let searchUrl = bibtex_route.url.replace("@@", encodeURIComponent(keyword));
      keyword = await findDomFromUrl(searchUrl, bibtex_route.dom);
      if (!keyword) {
        addUnavailableItem(item, "在 " + searchUrl + " 中未找到 " + bibtex_route.dom + " 的链接！", searchUrlBaseName);
        findError = true;
        break;
      }
      // 处理关键词
      let keyword_regex = bibtex_route.keyword_regex;
      for (let regex in keyword_regex) {
        keyword = keyword.replace(regex, keyword_regex[regex]);
      }
    }

    if (!keyword || findError) {
      addUnavailableItem(item, "未找到 BibTeX 链接！", searchUrlBaseName); // 返回错误信息
      continue; 
    }
    
    // 访问 BibTex 链接并获取 BibTex 内容
    let bibtexLink = keyword;
    const parsedBibtex = await getBibtexContent(bibtexLink);
    if (!parsedBibtex.entryType) {
      addUnavailableItem(item, parsedBibtex, searchUrlBaseName);
      continue;
    }

    // 更新 Zotero 条目

    // 检查 Zotero 条目的类型是否与 BibTeX 类型匹配，如果不匹配则新建条目
    try {
      let newItemType = typeMapping[parsedBibtex.entryType];
      let newItemTypeID = Zotero.ItemTypes.getID(newItemType);
      if (newItemTypeID !== item.getType()) {
        // 类型修改是被禁用的，所以这里需要创建一个新条目来更新对应的 BibTeX 信息
        // item.setType(newItemTypeID);

        let newItem = await createNewItem(item, newItemTypeID);
        if (typeof newItem === "string") {
          return newItem; // 返回错误信息
        }

        // 用 BibTeX 条目的内容更新新条目，而不是旧条目
        item = newItem;
      }
    } catch (error) {
      addUnavailableItem(item, "新建 BibTex 对应的 Zotero 条目失败！", searchUrlBaseName);
      continue;
    }

    let isSuccess = await updateItem(item, parsedBibtex, fieldMapping);
    if (isSuccess != true) {
      addUnavailableItem(item, isSuccess, searchUrlBaseName);
      continue;
    }
    // 更新成功
    addAvailableItem(item, searchUrlBaseName);
  }
}

let message = "";
if (unavailableItems.length > 0) {
  message = "以下条目无法更新，可能是因为网络原因或 dblp 里没收录：\n";
  for (let item of unavailableItems) {
    message +=
      "源 " + item[2] + " => [ERROR " + item[1].toString() + "] " + item[0].getField("title") + "\n";
  }
  if (availableItems.length > 0) {
    message += "\n";
    message += "以下条目已成功更新：\n";
    for (let item of availableItems) {
      message += "源 " + item[1] + " => " + item[0].getField("title") + "\n";
    }
  }
  return message;
} else {
  return "没有任何问题！全部完美完成任务！";
}
