// ==UserScript==
// @name         Temu补报活动自动处理
// @namespace    http://tampermonkey.net/
// @version      4.3
// @description  自动填入参考价，判断是否低于成本价，低于则翻页跳过，全部高于则确认报名（确认后弹窗回到第1页，自动继续遍历未提交的页）
// @author       QoderWork
// @match        https://agentseller.temu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var COST_THRESHOLD = 45;
  var POLL_INTERVAL = 500;
  var MAX_WAIT = 15000;
  var PRICE_PLACEHOLDER = '请输入';

  // ============ 工具函数 ============

  function log(msg) {
    var el = document.getElementById('temu-auto-log');
    if (el) {
      el.textContent = msg;
      console.log('[Temu补报]', msg);
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ============ DOM 定位函数 ============

  function isDialogOpen() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === '确认报名') return true;
    }
    return false;
  }

  function findFillPriceLink() {
    var links = document.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      if (links[i].textContent.trim().includes('一键填入参考价')) return links[i];
    }
    return null;
  }

  function getPriceInputs() {
    var allInputs = document.querySelectorAll('input');
    var matched = [];
    for (var i = 0; i < allInputs.length; i++) {
      if (allInputs[i].getAttribute('placeholder') === PRICE_PLACEHOLDER) {
        matched.push(allInputs[i]);
      }
    }
    return matched;
  }

  function getCurrentPage() {
    var activeItem = document.querySelector('[class*="PGT_pagerItemActi"]');
    if (activeItem) {
      var num = parseInt(activeItem.textContent.trim(), 10);
      if (!isNaN(num)) return num;
    }
    return 1;
  }

  function findNextPageBtn() {
    var nextBtn = document.querySelector('[class*="PGT_next"]');
    if (nextBtn) {
      var cls = nextBtn.className || '';
      if (cls.indexOf('disabled') >= 0 || nextBtn.getAttribute('aria-disabled') === 'true') {
        return null;
      }
      return nextBtn;
    }
    return null;
  }

  function findConfirmBtn() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === '确认报名') return btns[i];
    }
    return null;
  }

  // ============ 核心操作 ============

  /** 触发 React 兼容的 input 事件，让 React 识别到值变化 */
  function triggerInputEvents(input) {
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, input.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 勾选"全选"复选框，使"确认报名"按钮启用 */
  function checkSelectAll() {
    var cb = document.getElementById('dxm_checkbox');
    if (cb && !cb.checked) {
      cb.click();
      return true;
    }
    return cb ? true : false; // 已勾选或不存在
  }

  /** 点击二次确认弹窗的"确认"按钮（"确认立即报名 N 条吗？"） */
  async function clickSecondaryConfirm() {
    // 等待二次确认弹窗出现
    var waitStart = Date.now();
    while (Date.now() - waitStart < MAX_WAIT) {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (t === '确认') {
          // 检查是否在二次确认弹窗中（旁边有"取消"按钮）
          var parent = btns[i].parentElement;
          if (parent) {
            var siblings = parent.querySelectorAll('button');
            for (var j = 0; j < siblings.length; j++) {
              if (siblings[j].textContent.trim() === '取消') {
                btns[i].click();
                log('已点击二次确认弹窗的"确认"');
                return true;
              }
            }
          }
        }
      }
      await sleep(POLL_INTERVAL);
    }
    log('未找到二次确认弹窗');
    return false;
  }

  /** 强制启用"确认报名"按钮（移除 CSS 禁用类 + HTML 属性） */
  function forceEnableConfirmBtn() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === '确认报名') {
        var btn = btns[i];
        // 移除 CSS 禁用类 (BTN_disabled_xxx)
        var classes = btn.className.split(/\s+/);
        for (var j = classes.length - 1; j >= 0; j--) {
          if (classes[j].indexOf('BTN_disabled') >= 0) {
            btn.classList.remove(classes[j]);
          }
        }
        // 移除 HTML 禁用属性
        btn.disabled = false;
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-disabled');
        return btn;
      }
    }
    return null;
  }

  /** 点击"一键填入参考价"并等待价格填完 */
  async function clickFillAndWait() {
    var fillLink = findFillPriceLink();
    if (!fillLink) throw new Error('未找到"一键填入参考价"按钮');

    var inputs = getPriceInputs();
    if (inputs.length === 0) throw new Error('未找到价格输入框');

    // 已填完则跳过（但仍触发事件让 React 感知）
    var allFilled = true;
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].value || parseFloat(inputs[i].value) <= 0) { allFilled = false; break; }
    }
    if (allFilled) {
      log('价格已填好，触发事件同步...');
      // 触发事件让 React 识别到值
      for (var t = 0; t < inputs.length; t++) triggerInputEvents(inputs[t]);
      return;
    }

    // 记录快照
    var beforePrices = [];
    for (var j = 0; j < inputs.length; j++) beforePrices.push(inputs[j].value);

    fillLink.click();
    log('已点击"一键填入参考价"，等待填充...');

    // 轮询等待
    var startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT) {
      await sleep(POLL_INTERVAL);
      var cur = getPriceInputs();
      var changed = false;
      var filledCount = 0;
      for (var k = 0; k < cur.length; k++) {
        if (cur[k].value !== beforePrices[k]) changed = true;
        if (cur[k].value && parseFloat(cur[k].value) > 0) filledCount++;
      }
      if (filledCount === cur.length) {
        log('价格填充完成');
        // 填充完成后触发事件让 React 感知
        for (var e = 0; e < cur.length; e++) triggerInputEvents(cur[e]);
        return;
      }
      if (changed && filledCount >= cur.length * 0.8) {
        log('价格基本填充完成');
        for (var e2 = 0; e2 < cur.length; e2++) triggerInputEvents(cur[e2]);
        return;
      }
    }

    var finalInputs = getPriceInputs();
    var fc = 0;
    for (var m = 0; m < finalInputs.length; m++) {
      if (finalInputs[m].value && parseFloat(finalInputs[m].value) > 0) fc++;
    }
    log('价格填充超时，' + fc + '/' + finalInputs.length + ' 已填充');
    for (var e3 = 0; e3 < finalInputs.length; e3++) triggerInputEvents(finalInputs[e3]);
  }

  /** 检查当前页低于阈值的价格条目 */
  function checkBelowThreshold(threshold) {
    var inputs = getPriceInputs();
    var below = [];
    for (var i = 0; i < inputs.length; i++) {
      var price = parseFloat(inputs[i].value);
      if (!isNaN(price) && price < threshold) {
        var row = inputs[i].closest('tr');
        var info = '第' + (i + 1) + '行';
        if (row) info = row.textContent.replace(/\s+/g, ' ').trim().substring(0, 60);
        below.push({ price: price, info: info });
      }
    }
    return below;
  }

  /** 翻到下一页 */
  async function goToNextPage() {
    var nextBtn = findNextPageBtn();
    if (!nextBtn) throw new Error('已到最后一页');

    var beforePrices = [];
    var curInputs = getPriceInputs();
    for (var i = 0; i < curInputs.length; i++) beforePrices.push(curInputs[i].value);

    var currentPage = getCurrentPage();
    log('当前第' + currentPage + '页，点击下一页...');
    nextBtn.click();

    var startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT) {
      await sleep(POLL_INTERVAL);
      var cur = getPriceInputs();
      var changed = false;
      for (var j = 0; j < cur.length; j++) {
        if (cur[j].value !== beforePrices[j]) { changed = true; break; }
      }
      if (changed) {
        log('已翻到第' + getCurrentPage() + '页');
        return true;
      }
    }
    throw new Error('翻页超时');
  }

  /** 检查当前页价格是否已全部填好（用于判断该页是否已提交过） */
  function isPageAlreadyFilled() {
    var inputs = getPriceInputs();
    if (inputs.length === 0) return false;
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].value || parseFloat(inputs[i].value) <= 0) return false;
    }
    return true;
  }

  // ============ 主流程 ============
  // 策略：每页都处理（填价→判断→提交或跳过）
  // 完成检测：一轮完整遍历（从第1页到最后一页）如果没有提交任何页，则结束

  async function runAutoProcess() {
    var thresholdInput = document.getElementById('temu-cost-input');
    var threshold = parseFloat(thresholdInput ? thresholdInput.value : COST_THRESHOLD) || COST_THRESHOLD;

    if (isNaN(threshold) || threshold <= 0) {
      log('请输入有效的成本价');
      return;
    }

    if (!isDialogOpen()) {
      log('请先打开"补报活动"弹窗');
      return;
    }

    log('开始自动处理，成本价阈值: ¥' + threshold);

    var startBtn = document.getElementById('temu-start-btn');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '运行中...';
    }

    try {
      var submitCount = 0;
      var skipCount = 0;
      var maxLoop = 300;
      var loopCount = 0;
      var passSubmitted = 0;   // 本轮遍历提交了几页
      var lastPageReached = false; // 是否到了最后一页

      while (loopCount < maxLoop) {
        loopCount++;

        if (!isDialogOpen()) {
          log('弹窗已关闭，停止处理');
          break;
        }

        var currentPage = getCurrentPage();
        var inputs = getPriceInputs();

        if (inputs.length === 0) {
          log('未找到价格输入框，可能所有SKU已处理完');
          break;
        }

        // 每页都处理：先填价
        log('检查第 ' + currentPage + ' 页...');
        await clickFillAndWait();
        await sleep(500);

        var belowItems = checkBelowThreshold(threshold);
        var allInputs = getPriceInputs();
        var priceSummary = [];
        for (var p = 0; p < allInputs.length; p++) priceSummary.push(allInputs[p].value || '?');
        log('第' + currentPage + '页价格: [' + priceSummary.join(', ') + ']，低于¥' + threshold + ': ' + belowItems.length + '条');

        if (belowItems.length > 0) {
          // 有低于阈值的，跳过
          skipCount++;
          var prices = [];
          for (var b = 0; b < belowItems.length; b++) prices.push('¥' + belowItems[b].price);
          log('第' + currentPage + '页有 ' + belowItems.length + ' 条低于¥' + threshold + ' (' + prices.join(', ') + ')，跳过');

          var nextBtn = findNextPageBtn();
          if (!nextBtn) {
            // 到了最后一页且低于阈值
            lastPageReached = true;
            if (passSubmitted === 0) {
              log('一轮遍历完成，无更多可提交，共提交 ' + submitCount + ' 页，跳过 ' + skipCount + ' 页');
              break;
            }
            // 本轮有提交过，开始新一轮
            passSubmitted = 0;
            log('开始新一轮遍历...');
            await sleep(500);
            continue;
          }
          await goToNextPage();
          await sleep(500);
        } else {
          // 全部 >= 阈值，确认报名
          log('第' + currentPage + '页全部 >= ¥' + threshold + '，准备确认报名...');

          // 先勾选"全选"复选框，使确认按钮启用
          checkSelectAll();
          await sleep(500);

          // 尝试点击"确认报名"按钮，最多重试3次
          var clicked = false;
          for (var attempt = 0; attempt < 3; attempt++) {
            var confirmBtn = forceEnableConfirmBtn();
            if (!confirmBtn) {
              log('未找到"确认报名"按钮');
              break;
            }

            if (attempt > 0) log('第' + (attempt + 1) + '次尝试点击确认...');
            await sleep(200);
            confirmBtn.click();
            confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

            // 处理二次确认弹窗 "确认立即报名 N 条吗？"
            var secondaryOk = await clickSecondaryConfirm();
            if (!secondaryOk) {
              log('二次确认未通过，重试...');
              continue;
            }

            // 等待主对话框重置
            await sleep(2000);
            var newPage = getCurrentPage();
            var newInputs = getPriceInputs();

            // 判断提交是否成功：页码变回1，或价格输入框内容变化（items被移除）
            if (newPage === 1 || newInputs.length === 0) {
              clicked = true;
              submitCount++;
              passSubmitted++;
              log('确认成功！（累计 ' + submitCount + ' 页），对话框回到第' + newPage + '页');
              await sleep(500);
              break;
            }

            log('点击后对话框未重置（仍在第' + newPage + '页），重试...');
          }

          if (!clicked) {
            log('确认按钮点击3次均未生效，已提交 ' + submitCount + ' 页，脚本停止。请检查是否有未完成的验证步骤');
            break;
          }
        }
      }

      if (loopCount >= maxLoop) {
        log('达到最大循环次数，已提交 ' + submitCount + ' 页');
      }
    } catch (error) {
      log('出错: ' + error.message);
      console.error('[Temu补报]', error);
    } finally {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = '开始执行';
      }
    }
  }

  // ============ 控制面板 ============

  function createControlPanel() {
    if (document.getElementById('temu-auto-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'temu-auto-panel';
    panel.innerHTML =
      '<div id="temu-auto-header">' +
        '<span>Temu 补报自动处理</span>' +
        '<button id="temu-close-btn" title="关闭">✕</button>' +
      '</div>' +
      '<div id="temu-auto-body">' +
        '<div class="temu-row">' +
          '<label>成本价阈值 (元):</label>' +
          '<input type="number" id="temu-cost-input" value="' + COST_THRESHOLD + '" min="0" step="0.01" />' +
        '</div>' +
        '<div class="temu-row">' +
          '<button id="temu-start-btn">▶ 开始执行</button>' +
        '</div>' +
        '<div id="temu-auto-log">等待操作... 请先打开补报活动弹窗</div>' +
      '</div>';

    var style = document.createElement('style');
    style.textContent =
      '#temu-auto-panel{position:fixed;top:120px;right:20px;z-index:999999;width:300px;' +
      'background:#fff;border:1px solid #ddd;border-radius:8px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.15);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:13px;color:#333;user-select:none}' +
      '#temu-auto-header{display:flex;justify-content:space-between;align-items:center;' +
      'padding:10px 14px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);' +
      'color:#fff;border-radius:8px 8px 0 0;font-weight:600;font-size:14px;cursor:move}' +
      '#temu-close-btn{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 4px}' +
      '#temu-close-btn:hover{opacity:0.7}' +
      '#temu-auto-body{padding:14px}' +
      '.temu-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}' +
      '.temu-row label{white-space:nowrap;font-size:13px;color:#555}' +
      '#temu-cost-input{width:80px;padding:5px 8px;border:1px solid #ccc;border-radius:4px;' +
      'font-size:14px;text-align:center}' +
      '#temu-cost-input:focus{outline:none;border-color:#667eea;box-shadow:0 0 0 2px rgba(102,126,234,0.2)}' +
      '#temu-start-btn{width:100%;padding:8px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);' +
      'color:#fff;border:none;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer}' +
      '#temu-start-btn:hover:not(:disabled){opacity:0.9}' +
      '#temu-start-btn:disabled{opacity:0.5;cursor:not-allowed}' +
      '#temu-auto-log{margin-top:8px;padding:8px 10px;background:#f8f9fa;border-radius:4px;' +
      'font-size:12px;color:#666;min-height:20px;line-height:1.5;word-break:break-all}';

    document.head.appendChild(style);
    document.body.appendChild(panel);

    document.getElementById('temu-start-btn').addEventListener('click', runAutoProcess);
    document.getElementById('temu-close-btn').addEventListener('click', function () {
      panel.remove();
      style.remove();
    });

    makeDraggable(panel, document.getElementById('temu-auto-header'));
  }

  function makeDraggable(panel, handle) {
    var isDragging = false;
    var startX, startY, origX, origY;

    handle.addEventListener('mousedown', function (e) {
      if (e.target.id === 'temu-close-btn') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      panel.style.left = (origX + e.clientX - startX) + 'px';
      panel.style.top = (origY + e.clientY - startY) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', function () { isDragging = false; });
  }

  // ============ 启动 ============

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createControlPanel);
  } else {
    createControlPanel();
  }

})();
