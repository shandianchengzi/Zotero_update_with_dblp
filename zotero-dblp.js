function fetchWithTimeout(url, timeout = 3000) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), timeout)
    ),
  ]);
}

async function getBibtexContent(bibtexLink, method = "get") {
  // for post
  if (method == "post") {
    const response = await fetchWithTimeout(bibtexLink, {
      method: "POST",
      body: "format=pubmed",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })
      .then(async (bibtexContent) => {
        // 处理响应
        bibtexContent = await bibtexContent.text();
        return bibtexContent;
      })
      .catch((error) => {
        // 处理错误
        return "BibTeX 链接请求超时！";
      });
    return response;
  }
  // for get (default)
  const response = await fetchWithTimeout(bibtexLink)
    .then(async (bibtexContent) => {
      // 处理响应
      bibtexContent = await bibtexContent.text();
      return bibtexContent;
    })
    .catch((error) => {
      // 处理错误
      return "BibTeX 链接请求超时！";
    });
  return response;
}

async function findDomFromUrl(url, dom, dom_feature) {
  const response = await fetchWithTimeout(url)
    .then(async (searchHtml) => {
      // 处理响应
      searchHtml = await searchHtml.text();

      // 使用 DOMParser 解析 HTML 字符串
      const parser = new DOMParser();
      const doc = parser.parseFromString(searchHtml, "text/html");

      // 查找第一个条目的 dom 链接
      const firstEntryBibtexLink = doc.querySelector(dom);

      const domLink = firstEntryBibtexLink.getAttribute(dom_feature); // link or undefined
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

function createNewItem(item, newItemTypeID) {
  let newItem = new Zotero.Item(newItemTypeID);
  // 将新条目设置在与旧条目相同的文库中
  newItem.setField("libraryID", item.libraryID);
  // 将新条目移动到与旧条目相同的集合中
  newItem.setCollections(item.getCollections());
  return newItem;
}

function updateItem(item, newItem, newPrior = false) {
  // if newPrior is true, then newItem's value will be prior
  let itemTypeID = item.getType();

  // 获取该条目类型支持的所有字段
  let itemTypeFields = Zotero.ItemFields.getItemTypeFields(itemTypeID);
  let fieldName, newvalue, oldvalue;

  for (let fieldID of itemTypeFields) {
    fieldName = Zotero.ItemFields.getName(fieldID);

    // 检查新条目是否有这个字段
    if (newItem.getField(fieldName)) {
      newvalue = newItem.getField(fieldName);
      if (newvalue) {
        oldvalue = item.getField(fieldName);
        // 如果旧条目的值不为空，且newPrior为true，则更新；如果旧条目值为空，也更新。否则不做处理
        if ((oldvalue && newPrior) || !oldvalue) {
          item.setField(fieldName, newvalue);
        }
      }
    }
  }

  // 特殊处理作者和编辑字段(creators)
  let oldCreators = item.getCreators();
  let newCreators = newItem.getCreators();
  if (newPrior) {
    oldCreators = newItem.getCreators();
    newCreators = item.getCreators();
  }
  let needAddAuthor = true;
  let needAddEditor = true;
  let finalCreators = [];
  // 当且仅当旧条目中没有作者或编辑时，才将新条目的作者或编辑添加到旧条目中；如果newPrior为true，则反之
  for (let c of oldCreators) {
    let creatorType = Zotero.CreatorTypes.getName(c.creatorTypeID);
    if (creatorType == "author") needAddAuthor = false;
    else if (creatorType == "editor") needAddEditor = false;
    finalCreators.push(c);
  }
  for (let c of newCreators) {
    let creatorType = Zotero.CreatorTypes.getName(c.creatorTypeID);
    if (
      (creatorType == "author" && needAddAuthor) ||
      (creatorType == "editor" && needAddEditor)
    )
      finalCreators.push(c);
  }
  item.setCreators(finalCreators);

  return item;
}

async function copyAttachments(newItem, item) {
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
  dblp: {
    bibtex_route: [
      {
        url: "https://dblp.org/search?q=@@",
        dom: 'li.entry .drop-down .body a[href*="?view=bibtex"]',
        keyword_regex: { ".html?view=bibtex": ".bib" },
      },
    ],
  },
  google_scholar: {
    bibtex_route: [
      {
        url: "https://scholar.google.com/scholar?q=@@/&output=cite",
        dom: "a.gs_citi", // 'div.gs_r',
      },
      // {
      //   url: "info:@@:scholar.google.com/",
      //   dom: 'a.gs_citi',
      // }
    ],
  },
  pubmed: {
    bibtex_route: [
      {
        url: "https://pubmed.ncbi.nlm.nih.gov/?term=@@",
        dom: "div.cite",
        dom_feature: "data-pubmed-format-link",
        method: "post",
        format: "nbib",
      },
    ],
  },
};

// init default searchUrlBases
for (let searchUrlBaseName in searchUrlBases) {
  let searchUrlBase = searchUrlBases[searchUrlBaseName];
  for (let bibtex_route of searchUrlBase.bibtex_route) {
    if (!bibtex_route.keyword_regex) {
      bibtex_route.keyword_regex = {};
    }
    if (!bibtex_route.method) {
      bibtex_route.method = "get";
    }
    if (!bibtex_route.dom_feature) {
      bibtex_route.dom_feature = "href";
    }
    if (!bibtex_route.format) {
      bibtex_route.format = "bibtex";
    }
  }
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
    try {
      let searchUrlBase = searchUrlBases[searchUrlBaseName];
      // 支持深查找网页，获取 BibTeX 链接
      let keyword = title;
      let findError = false;
      for (let bibtex_route of searchUrlBase.bibtex_route) {
        let searchUrl = bibtex_route.url.replace(
          "@@",
          encodeURIComponent(keyword)
        );

        keyword = await findDomFromUrl(
          searchUrl,
          bibtex_route.dom,
          bibtex_route.dom_feature
        );
        if (!keyword) {
          addUnavailableItem(
            item,
            "在 " + searchUrl + " 中未找到 " + bibtex_route.dom + " 的链接！",
            searchUrlBaseName
          );
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
      const bibtexContent = await getBibtexContent(
        bibtexLink,
        searchUrlBase.bibtex_route.method
      );

      // 通过 Translator 'BibTex' 解析 BibTeX 内容
      var translate = new Zotero.Translate.Import();
      translate.setString(bibtexContent);
      translate.setTranslator("9cb70025-a888-4a29-a210-93ec52da40d4");
      let newItems = await translate.translate();
      let parsedBibtexItem = newItems[0];

      // 检查 Zotero 条目的类型是否与 BibTeX 类型匹配，如果匹配则在原条目上更新，否则创建新条目
      if (parsedBibtexItem.getType() == item.getType()) {
        item = updateItem(item, parsedBibtexItem, false);
        // 保存更新后的条目
        await item.saveTx();
      } else {
        // 创建新条目
        let newItem = createNewItem(item, parsedBibtexItem.getType());
        // 更新新条目信息
        newItem = updateItem(newItem, parsedBibtexItem, true);
        // 将旧条目的信息更新到新条目中，这样就能保证新条目不会覆盖旧条目的信息
        newItem = updateItem(newItem, item, true);
        // 保存新条目并移动附件
        newItem = await copyAttachments(newItem, item);
        // **不删除旧条目，避免其他类型的信息丢失**
      }

      // 删除BibTex导入的条目，避免条目重复
      await parsedBibtexItem.eraseTx();

      // 更新成功
      addAvailableItem(item, searchUrlBaseName);
    } catch (error) {
      addUnavailableItem(item, error, searchUrlBaseName);
    }
  }
}

let message = "";
let availableItemsName = [];
if (availableItems.length > 0) {
  message += "以下条目已成功更新：\n";
  for (let item of availableItems) {
    message += "源 " + item[1] + " => " + item[0].getField("title") + "\n";
    availableItemsName.push(item[0].getField("title"));
  }
}
let newUnavailableItems = [];
for (let item of unavailableItems) {
  if (availableItemsName.indexOf(item[0].getField("title")) != -1) {
    continue;
  } else {
    newUnavailableItems.push(item);
  }
}

if (newUnavailableItems.length > 0) {
  message += "\n";
  message += "以下条目无法更新，可能是因为网络原因或 dblp 里没收录：\n";
  for (let item of newUnavailableItems) {
    message +=
      "源 " +
      item[2] +
      " => [ERROR " +
      item[1].toString() +
      "] " +
      item[0].getField("title") +
      "\n";
  }
}

return message;
