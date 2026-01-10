// ==UserScript==
// @name         Opinion.trade 自动交易脚本
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  自动化 Opinion.trade 交易流程:选择选项→输入金额→等待→卖出
// @author       Your Name
// @match        https://app.opinion.trade/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @icon         https://app.opinion.trade/favicon.ico
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置管理 ====================
    const DEFAULT_CONFIG = {
        marketUrl: 'https://app.opinion.trade/detail?topicId=61&type=multi',
        optionName: 'No change',
        tradeAmount: 10,
        holdTime: 60,
        tradeType: 'YES',
        autoStart: false,
        waitBeforeTrade: 2,
        retryAttempts: 3,
        enableLog: true,
        sellWaitTime: 5  // 卖出前等待时间(秒)
    };

    const Config = {
        get: (key) => {
            const value = GM_getValue(key, DEFAULT_CONFIG[key]);
            return value;
        },
        set: (key, value) => {
            GM_setValue(key, value);
        },
        getAll: () => {
            const config = {};
            for (const key in DEFAULT_CONFIG) {
                config[key] = GM_getValue(key, DEFAULT_CONFIG[key]);
            }
            return config;
        },
        setAll: (values) => {
            for (const key in values) {
                GM_setValue(key, values[key]);
            }
        },
        reset: () => {
            for (const key in DEFAULT_CONFIG) {
                GM_setValue(key, DEFAULT_CONFIG[key]);
            }
        }
    };

    // ==================== 日志函数 ====================
    const log = (message, type = 'info') => {
        if (!Config.get('enableLog')) return;
        const prefix = '[Opinion Auto Trader]';
        const colors = {
            info: '#00bfff',
            success: '#00ff00',
            error: '#ff4444',
            warn: '#ffaa00'
        };
        console.log(`%c${prefix}`, `color: ${colors[type]}; font-weight: bold`, message);
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const waitForElement = (selector, timeout = 10000) => {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver((mutations, obs) => {
                const element = document.querySelector(selector);
                if (element) {
                    obs.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`元素未找到: ${selector}`));
            }, timeout);
        });
    };

    // ==================== 核心交易逻辑 ====================
    // 全局交易实例追踪
    let currentTrader = null;

    class OpinionTrader {
        constructor() {
            this.config = Config.getAll();
            this.isRunning = false;
            this.shouldStop = false;
        }

        async findOptionButton(optionName) {
            log(`正在查找选项: ${optionName}`, 'info');
            const buttons = Array.from(document.querySelectorAll('button'));
            // 查找包含选项名称的按钮(不需要同时包含YES和NO)
            const optionButton = buttons.find(btn =>
                btn.textContent.includes(optionName) &&
                btn.textContent.includes('$') &&
                btn.textContent.includes('%')
            );

            if (!optionButton) {
                throw new Error(`未找到选项: ${optionName}`);
            }

            log(`找到选项按钮: ${optionName}`, 'success');
            return optionButton;
        }

        async selectOption(optionName) {
            log(`准备选择选项: ${optionName}`, 'info');
            const button = await this.findOptionButton(optionName);
            button.click();
            await sleep(1000);
            log(`选项已选择`, 'success');
        }

        async findTradeButton(type) {
            log(`正在查找 ${type} 交易按钮`, 'info');
            await sleep(500);

            const buttons = Array.from(document.querySelectorAll('button'));
            // 查找YES/NO按钮,这些按钮通常包含价格信息(如"92.6¢")
            const tradeButton = buttons.find(btn => {
                const text = btn.textContent.trim();
                // 按钮文本应该以类型(YES/NO)开头,可能包含价格
                return text.startsWith(type) ||
                       (text.includes(type) && text.includes('¢'));
            });

            if (!tradeButton) {
                throw new Error(`未找到 ${type} 交易按钮`);
            }

            log(`找到 ${type} 交易按钮: ${tradeButton.textContent.trim()}`, 'success');
            return tradeButton;
        }

        async findAmountInput() {
            log(`正在查找金额输入框`, 'info');
            const inputs = Array.from(document.querySelectorAll('input[type="text"]'));

            // 查找金额输入框,通常在"Amount"标签附近
            // 过滤掉价格输入框(通常包含数字,而金额输入框默认是"0")
            const amountInput = inputs.find(input => {
                const value = input.value || input.placeholder || '';
                // 金额输入框通常默认为"0"或空
                return (value === '0' || value === '') &&
                       input.placeholder === '0';
            });

            if (!amountInput) {
                throw new Error('未找到金额输入框');
            }

            log(`找到金额输入框`, 'success');
            return amountInput;
        }

        async inputAmount(amount) {
            log(`准备输入金额: ${amount}`, 'info');
            const input = await this.findAmountInput();

            // 先聚焦输入框
            input.click();
            input.focus();
            await sleep(300);

            // 使用原生方法设置值
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;

            // 清空输入框
            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(100);

            // 设置新值
            nativeInputValueSetter.call(input, amount.toString());

            // 触发所有可能的事件
            const events = [
                new Event('input', { bubbles: true }),
                new Event('change', { bubbles: true }),
                new KeyboardEvent('keydown', { bubbles: true, key: amount.toString() }),
                new KeyboardEvent('keyup', { bubbles: true, key: amount.toString() }),
            ];

            events.forEach(event => input.dispatchEvent(event));

            // 聚焦失活事件
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            await sleep(500);

            // 验证输入是否成功
            if (input.value !== amount.toString()) {
                log(`⚠️ 金额输入可能失败,当前值: ${input.value}`, 'warn');
            } else {
                log(`✅ 金额已输入: ${amount}`, 'success');
            }

            // 额外等待,让框架有时间更新UI
            await sleep(500);
        }

        async findBuyButton() {
            log('正在查找购买按钮...', 'info');

            // 查找购买按钮 - 优先查找包含 "Buy" 文本且带有特定样式的 div 元素
            // 购买按钮是一个 div,包含 "Buy No change - YES/NO" 格式的文本
            let buyButton = null;

            // 方法1: 查找包含 "Buy" 文本且样式为圆角白底的 div
            const divs = Array.from(document.querySelectorAll('div'));
            buyButton = divs.find(div => {
                const text = div.textContent.trim();
                const classes = div.className || '';
                // 检查是否包含 "Buy" 和选项名称,以及是否有购买按钮的样式特征
                return text.startsWith('Buy') &&
                       (text.includes('YES') || text.includes('NO')) &&
                       classes.includes('rounded-full') &&
                       (classes.includes('bg-white') || classes.includes('cursor-pointer'));
            });

            // 方法2: 如果方法1没找到,尝试查找包含 "Buy" 的所有可点击元素
            if (!buyButton) {
                const allElements = Array.from(document.querySelectorAll('div, button'));
                buyButton = allElements.find(el => {
                    const text = el.textContent.trim();
                    // 匹配 "Buy [选项名] - YES/NO" 格式
                    return /^Buy\s+.+\s*-\s*(YES|NO)$/.test(text);
                });
            }

            if (!buyButton) {
                throw new Error('未找到购买按钮');
            }

            log(`找到购买按钮: ${buyButton.textContent.trim()}`, 'success');
            return buyButton;
        }

        async verifyTradeSuccess() {
            log('正在验证交易是否成功...', 'info');
            await sleep(3000); // 等待交易处理

            // 检查是否有错误提示
            const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"]');
            for (const elem of errorElements) {
                if (elem.textContent && elem.textContent.trim()) {
                    log(`⚠️ 检测到错误: ${elem.textContent.trim()}`, 'warn');
                }
            }

            // 检查持仓是否创建成功
            const positionTab = document.querySelector('button[tabindex="0"]');
            if (positionTab) {
                log('✅ 交易可能已成功,请检查持仓页面确认', 'success');
            } else {
                log('⚠️ 无法验证交易是否成功,请手动检查持仓', 'warn');
            }
        }

        async checkWalletConnection() {
            log('检查钱包连接状态...', 'info');
            const connectButton = Array.from(document.querySelectorAll('button')).find(btn =>
                btn.textContent.includes('Connect Wallet')
            );

            if (connectButton) {
                log('⚠️ 钱包未连接,请先连接钱包!', 'error');
                throw new Error('钱包未连接,请先点击"Connect Wallet"按钮连接钱包');
            }

            // 检查余额
            const balanceText = document.body.textContent;
            const hasBalance = !balanceText.includes('Balance\n-') &&
                              !balanceText.includes('Balance -');

            if (!hasBalance) {
                log('⚠️ 钱包余额为空或未加载!', 'warn');
            }

            log('✅ 钱包已连接', 'success');
        }

        async checkPositions() {
            log('正在检查持仓...', 'info');

            // 等待持仓页面加载
            await sleep(2000);

            // 查找持仓表格
            // 持仓信息在表格的 tbody 中,每一行代表一个持仓
            const positionRows = Array.from(document.querySelectorAll('tbody tr'));

            // 过滤掉空行(没有实际持仓数据的行)且持仓市值>1
            const hasPositions = positionRows.some(row => {
                const cells = Array.from(row.querySelectorAll('td'));

                // 检查行是否有足够的列(至少有 Outcome, Shares, Market Value 等列)
                if (cells.length < 3) return false;

                // 检查是否包含持仓特征: Outcome列包含 "YES"/"NO",且有 "Sell" 按钮
                const outcomeText = cells[0].textContent.trim();
                const hasSellButton = row.textContent.includes('Sell');
                const isValidPosition = (outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton;

                if (!isValidPosition) return false;

                // Market Value 在第3列(索引2)
                // 格式可能是: "$0.00" 或 "$1.23" 等
                const marketValueCell = cells[2];
                const marketValueText = marketValueCell.textContent.trim();

                // 提取市值数字,去掉$符号
                const marketValueMatch = marketValueText.match(/\$?([\d,]+\.?\d*)/);
                if (marketValueMatch) {
                    const marketValue = parseFloat(marketValueMatch[1].replace(/,/g, ''));
                    log(`持仓市值: ${marketValueText}`, 'info');

                    // 检查市值是否大于1
                    if (!isNaN(marketValue) && marketValue > 1) {
                        log(`✅ 检测到有效持仓(市值: $${marketValue})`, 'info');
                        return true;
                    }
                }

                return false;
            });

            if (hasPositions) {
                log('✅ 检测到现有持仓(市值>$1)', 'success');
                return true;
            } else {
                log('✅ 当前无持仓或市值≤$1', 'success');
                return false;
            }
        }

        async sellPosition() {
            log('准备卖出持仓...', 'info');

            // 查找持仓表格中的所有行
            const positionRows = Array.from(document.querySelectorAll('tbody tr'));
            let soldCount = 0;

            for (const row of positionRows) {
                const cells = Array.from(row.querySelectorAll('td'));

                // 检查行是否有足够的列
                if (cells.length < 3) continue;

                const outcomeText = cells[0].textContent.trim();
                const hasSellButton = row.textContent.includes('Sell');

                // 检查是否是我们要卖的持仓
                if ((outcomeText.includes(this.config.optionName) || outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton) {
                    // 获取Shares数量(第2列,索引1)
                    const sharesCell = cells[1];
                    const sharesText = sharesCell.textContent.trim();
                    log(`找到持仓: ${outcomeText}, Shares: ${sharesText}`, 'info');

                    // 查找该行的 Sell 按钮
                    const sellButton = Array.from(row.querySelectorAll('button')).find(btn =>
                        btn.textContent.trim() === 'Sell'
                    );

                    if (sellButton) {
                        log('点击持仓表格中的 Sell 按钮', 'info');
                        sellButton.click();

                        // 等待页面切换到卖出tab
                        log('等待切换到卖出页面...', 'info');
                        let sellTabFound = false;
                        for (let attempt = 0; attempt < 20; attempt++) {
                            // 查找Sell tab,确保它被选中(data-selected或aria-selected="true")
                            const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                                const text = tab.textContent.trim();
                                return text === 'Sell' &&
                                       (tab.hasAttribute('data-selected') ||
                                        tab.getAttribute('aria-selected') === 'true');
                            });

                            if (sellTab) {
                                log('✅ 已切换到卖出页面', 'success');
                                sellTabFound = true;
                                break;
                            }

                            await sleep(500);
                        }

                        if (!sellTabFound) {
                            log('⚠️ 未能切换到卖出页面,跳过此持仓', 'warn');
                            continue;
                        }

                        // 等待卖出页面的元素加载
                        await sleep(2000);

                        log('开始查找卖出页面元素...', 'info');

                        // 策略:先找到ID包含content-1的卖出tabpanel,然后在这个div内查找所有元素
                        let sellTabPanel = null;
                        let maxButton = null;
                        let sharesInput = null;
                        let sellConfirmButton = null;

                        // 第一步:找到ID包含content-1的卖出tabpanel
                        for (let attempt = 0; attempt < 10; attempt++) {
                            const tabPanels = Array.from(document.querySelectorAll('div[role="tabpanel"]'));
                            sellTabPanel = tabPanels.find(panel => {
                                return panel.id && panel.id.includes('content-1') &&
                                       panel.getAttribute('data-state') === 'open';
                            });

                            if (sellTabPanel) {
                                log('✅ 找到卖出tab面板 (ID包含content-1)', 'success');
                                break;
                            }

                            log(`等待卖出tab面板... (尝试 ${attempt + 1}/10)`, 'info');
                            await sleep(500);
                        }

                        if (!sellTabPanel) {
                            log('⚠️ 未找到激活的tab面板,跳过此持仓', 'warn');
                            continue;
                        }

                        // 第二步:先在这个tabpanel内查找Max按钮和Shares输入框
                        for (let attempt = 0; attempt < 15; attempt++) {
                            // 1. 在tabpanel内查找Max按钮
                            const maxButtons = Array.from(sellTabPanel.querySelectorAll('button'));
                            maxButton = maxButtons.find(btn => btn.textContent.trim() === 'Max');

                            // 2. 在tabpanel内查找Shares输入框 - 通过"Shares"标签定位
                            const labels = Array.from(sellTabPanel.querySelectorAll('p'));
                            const sharesLabel = labels.find(p => p.textContent.trim() === 'Shares');

                            if (sharesLabel) {
                                // 从Shares标签向上找到包含input的容器
                                let container = sharesLabel.parentElement;
                                while (container && !sharesInput) {
                                    sharesInput = container.querySelector('input[type="text"]');
                                    if (!sharesInput) {
                                        container = container.parentElement;
                                    }
                                }
                            }

                            // 调试信息
                            if (attempt === 0) {
                                log(`调试: TabPanel内Max按钮数量: ${maxButtons.filter(b => b.textContent === 'Max').length}`, 'info');
                                log(`调试: TabPanel内Shares标签: ${!!sharesLabel}`, 'info');
                                log(`调试: TabPanel内Shares输入框: ${!!sharesInput}`, 'info');
                            }

                            if (maxButton && sharesInput) {
                                log('✅ TabPanel内Max按钮和Shares输入框已找到', 'success');
                                break;
                            }

                            log(`等待TabPanel内Max按钮和Shares输入框加载... (尝试 ${attempt + 1}/15)`, 'info');
                            await sleep(500);
                        }

                        if (!maxButton || !sharesInput) {
                            log('⚠️ TabPanel内Max按钮或Shares输入框未找到,跳过此持仓', 'warn');
                            log(`缺失元素: Max=${!!maxButton}, Input=${!!sharesInput}`, 'info');
                            continue;
                        }

                        // 点击Max按钮设置最大份额
                        log('点击 Max 按钮设置最大份额', 'info');
                        maxButton.click();
                        await sleep(500);

                        // 验证输入框是否已填充
                        log(`Shares输入框当前值: ${sharesInput.value}`, 'info');

                        // 第三步:点击Max后再查找确认卖出按钮
                        log('查找确认卖出按钮...', 'info');
                        for (let attempt = 0; attempt < 15; attempt++) {
                            // 查找确认卖出按钮
                            const divs = Array.from(sellTabPanel.querySelectorAll('div'));
                            sellConfirmButton = divs.find(div => {
                                const text = div.textContent.trim();
                                return text.includes('Sell') &&
                                       (text.includes('YES') || text.includes('NO')) &&
                                       div.className.includes('rounded-full') &&
                                       !div.className.includes('bg-white-16');
                            });

                            if (sellConfirmButton) {
                                log('✅ 找到确认卖出按钮', 'success');
                                break;
                            }

                            log(`等待确认卖出按钮出现... (尝试 ${attempt + 1}/15)`, 'info');
                            await sleep(500);
                        }

                        if (!sellConfirmButton) {
                            log('⚠️ 未找到确认卖出按钮,跳过此持仓', 'warn');
                            continue;
                        }

                        // 等待确认按钮可操作
                        log('等待卖出按钮可操作...', 'info');
                        for (let attempt = 0; attempt < 20; attempt++) {
                            // 检查按钮是否可点击(没有disabled或cursor-not-allowed类)
                            const buttonClasses = sellConfirmButton.className || '';
                            const isDisabled = buttonClasses.includes('cursor-not-allowed') ||
                                             sellConfirmButton.hasAttribute('disabled');

                            if (!isDisabled) {
                                log('✅ 卖出按钮已可操作', 'success');
                                break;
                            }

                            if (attempt % 5 === 0) {
                                log(`继续等待按钮可操作... (尝试 ${attempt + 1}/20)`, 'info');
                            }
                            await sleep(500);
                        }

                        // 点击确认卖出按钮
                        log('点击确认卖出按钮', 'info');
                        sellConfirmButton.click();
                        soldCount++;

                        // 等待MetaMask钱包弹窗并提示用户确认
                        log('⏳ 请在MetaMask钱包中确认卖出交易...', 'warn');
                        log('⚠️ 脚本已暂停,请在钱包弹窗中点击"确认"按钮', 'warn');

                        // 等待交易确认(最长60秒),但会检测交易是否完成
                        let transactionConfirmed = false;
                        for (let i = 0; i < 60; i++) {
                            await sleep(1000);

                            // 检测交易是否已经完成:
                            // 1. 检查确认按钮是否被禁用或消失
                            // 2. 检查是否有成功提示
                            // 3. 检查页面是否有交易哈希
                            const buttonStillActive = sellConfirmButton &&
                                !sellConfirmButton.hasAttribute('disabled') &&
                                !sellConfirmButton.className.includes('cursor-not-allowed');

                            // 查找可能的成功提示
                            const successMessages = Array.from(document.querySelectorAll('*')).filter(el => {
                                const text = el.textContent.trim();
                                return text.includes('Transaction') &&
                                       (text.includes('submitted') ||
                                        text.includes('confirmed') ||
                                        text.includes('success'));
                            });

                            // 如果按钮被禁用或找到成功提示,认为交易已提交
                            if (!buttonStillActive || successMessages.length > 0) {
                                log('✅ 检测到交易已提交', 'success');
                                transactionConfirmed = true;
                                break;
                            }

                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待钱包确认... (${60-i}秒剩余)`, 'info');
                            }
                        }

                        if (!transactionConfirmed) {
                            log('⚠️ 60秒内未检测到交易确认,但继续执行', 'warn');
                        }

                        log('✅ 卖出订单已提交', 'success');
                        await sleep(2000);
                    }
                }
            }

            if (soldCount === 0) {
                log('⚠️ 未找到可卖出的持仓', 'warn');
            } else {
                log(`✅ 成功提交 ${soldCount} 个卖出订单`, 'success');
            }
        }

        async executeTrade() {
            try {
                log('=== 开始执行交易循环 ===', 'info');
                this.isRunning = true;
                this.shouldStop = false;

                // 持续循环执行交易
                let cycleCount = 0;
                while (!this.shouldStop) {
                    cycleCount++;
                    log(`\n========== 交易循环 #${cycleCount} ==========`, 'info');

                    // 检查钱包连接
                    if (this.shouldStop) throw new Error('用户手动停止');
                    await this.checkWalletConnection();

                    // 等待页面加载
                    if (this.shouldStop) throw new Error('用户手动停止');
                    if (cycleCount === 1) {
                        // 第一次循环才等待配置的时间
                        await sleep(this.config.waitBeforeTrade * 1000);
                    }

                    // 检查是否有持仓
                    const hasPositions = await this.checkPositions();

                    if (hasPositions) {
                        // === 有持仓:执行卖出流程 ===
                        log('📋 检测到持仓,准备卖出...', 'info');

                        // 等待配置的时间(默认5秒)
                        log(`⏳ 等待 ${this.config.sellWaitTime} 秒后开始卖出...`, 'info');
                        for (let i = 0; i < this.config.sellWaitTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                        }

                        // 执行卖出
                        await this.sellPosition();

                        // 卖出后等待持仓真正清空
                        log('⏳ 等待持仓清空确认...', 'info');
                        let positionsCleared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            // 检查持仓是否已经清空
                            const stillHasPositions = await this.checkPositions();

                            if (!stillHasPositions) {
                                log('✅ 持仓已清空', 'success');
                                positionsCleared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓清空... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsCleared) {
                            log('⚠️ 30秒内持仓未完全清空,但继续下一轮', 'warn');
                        }

                        log('✅ 卖出完成,准备开始下一轮交易...', 'success');
                        await sleep(1000);

                    } else {
                        // === 无持仓:执行买入流程 ===
                        log('📋 当前无持仓,准备买入...', 'info');

                        // 检查并切换到Buy tab
                        log('检查当前tab...', 'info');
                        const buyTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                            const text = tab.textContent.trim();
                            return text === 'Buy';
                        });

                        const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                            const text = tab.textContent.trim();
                            return text === 'Sell';
                        });

                        // 如果当前在Sell tab,需要切换到Buy tab
                        if (sellTab && sellTab.hasAttribute('data-selected')) {
                            log('当前在Sell tab,切换到Buy tab...', 'info');
                            if (buyTab) {
                                buyTab.click();
                                await sleep(1000);
                                log('✅ 已切换到Buy tab', 'success');
                            }
                        } else {
                            log('✅ 当前已在Buy tab', 'success');
                        }

                        // 选择选项(点击展开选项卡片)
                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.selectOption(this.config.optionName);
                        await sleep(1000);

                        // 点击YES/NO按钮
                        if (this.shouldStop) throw new Error('用户手动停止');
                        const tradeButton = await this.findTradeButton(this.config.tradeType);
                        log(`点击 ${this.config.tradeType} 按钮`, 'info');
                        tradeButton.click();
                        await sleep(1000);

                        // 输入金额
                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.inputAmount(this.config.tradeAmount);
                        await sleep(1000);

                        // 查找并点击购买按钮
                        if (this.shouldStop) throw new Error('用户手动停止');
                        const buyButton = await this.findBuyButton();
                        log('点击购买按钮', 'info');
                        buyButton.click();

                        // 等待MetaMask钱包弹窗并提示用户确认
                        log('⏳ 请在MetaMask钱包中确认交易...', 'warn');
                        log('⚠️ 脚本已暂停,请在钱包弹窗中点击"确认"按钮', 'warn');

                        // 检测钱包弹窗是否出现
                        let walletPopupDetected = false;
                        for (let i = 0; i < 10; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                            // 检测是否有MetaMask相关的DOM或iframe
                            const metamaskIframe = document.querySelector('iframe[src*="metamask"]') ||
                                                  document.querySelector('[class*="metamask"]') ||
                                                  document.querySelector('[id*="metamask"]');
                            if (metamaskIframe) {
                                walletPopupDetected = true;
                                log('✅ 检测到钱包弹窗,请确认...', 'info');
                                break;
                            }
                        }

                        // 给用户足够时间确认钱包(最长60秒),但会检测交易是否完成
                        log('⏳ 等待钱包确认中(最多60秒)...', 'info');
                        let transactionConfirmed = false;
                        for (let i = 0; i < 60; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);

                            // 检测交易是否已经完成:
                            // 1. 检查购买按钮是否被禁用或消失
                            // 2. 检查是否有成功提示
                            // 3. 检查是否有持仓出现
                            const buttonStillActive = buyButton &&
                                buyButton.parentElement &&
                                !buyButton.parentElement.hasAttribute('disabled') &&
                                !buyButton.parentElement.className.includes('cursor-not-allowed');

                            // 查找可能的成功提示
                            const successMessages = Array.from(document.querySelectorAll('*')).filter(el => {
                                const text = el.textContent.trim();
                                return text.includes('Transaction') &&
                                       (text.includes('submitted') ||
                                        text.includes('confirmed') ||
                                        text.includes('success'));
                            });

                            // 检查是否出现了持仓(买入成功后会出现持仓)
                            const positionRows = Array.from(document.querySelectorAll('tbody tr'));
                            const hasPositionsAfterBuy = positionRows.some(row => {
                                const cells = Array.from(row.querySelectorAll('td'));
                                if (cells.length < 3) return false;
                                const outcomeText = cells[0].textContent.trim();
                                const hasSellButton = row.textContent.includes('Sell');
                                return (outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton;
                            });

                            // 如果按钮被禁用、找到成功提示或出现持仓,认为交易已提交
                            if (!buttonStillActive || successMessages.length > 0 || hasPositionsAfterBuy) {
                                log('✅ 检测到交易已提交', 'success');
                                transactionConfirmed = true;
                                break;
                            }

                            // 每隔5秒提示一次
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待钱包确认... (${60-i}秒剩余)`, 'info');
                            }
                        }

                        if (!transactionConfirmed) {
                            log('⚠️ 60秒内未检测到交易确认,但继续执行', 'warn');
                        }

                        log('✅ 交易订单已提交', 'success');

                        // 验证交易是否成功
                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.verifyTradeSuccess();

                        // 等待持仓真正出现
                        log('⏳ 等待持仓确认...', 'info');
                        let positionsAppeared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            // 检查持仓是否已经出现
                            const hasPositionsNow = await this.checkPositions();

                            if (hasPositionsNow) {
                                log('✅ 持仓已确认', 'success');
                                positionsAppeared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓出现... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsAppeared) {
                            log('⚠️ 30秒内未检测到持仓出现,但继续执行', 'warn');
                        }

                        // 等待持仓时间
                        log(`⏳ 等待持仓 ${this.config.holdTime} 秒...`, 'info');
                        for (let i = 0; i < this.config.holdTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                            // 每10秒提示一次
                            if (i % 10 === 0 && i > 0) {
                                log(`⏳ 持仓倒计时... (${this.config.holdTime-i}秒剩余)`, 'info');
                            }
                        }

                        // 持仓时间结束,准备卖出
                        log('⏳ 持仓时间结束,准备卖出...', 'info');

                        // 等待配置的时间后卖出
                        log(`⏳ 等待 ${this.config.sellWaitTime} 秒后开始卖出...`, 'info');
                        for (let i = 0; i < this.config.sellWaitTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                        }

                        // 卖出操作
                        if (this.shouldStop) throw new Error('用户手动停止');
                        log('准备卖出持仓...', 'info');
                        await this.sellPosition();

                        // 卖出后等待持仓真正清空
                        log('⏳ 等待持仓清空确认...', 'info');
                        let positionsCleared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            // 检查持仓是否已经清空
                            const stillHasPositions = await this.checkPositions();

                            if (!stillHasPositions) {
                                log('✅ 持仓已清空', 'success');
                                positionsCleared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓清空... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsCleared) {
                            log('⚠️ 30秒内持仓未完全清空,但继续下一轮', 'warn');
                        }

                        log('✅ 卖出完成,准备开始下一轮交易...', 'success');
                        await sleep(1000);
                    }

                    log(`========== 循环 #${cycleCount} 完成 ==========\n`, 'success');
                }

                log('=== 交易循环已停止 ===', 'success');

            } catch (error) {
                if (error.message === '用户手动停止') {
                    log('⚠️ 交易已被用户停止', 'warn');
                } else {
                    log(`❌ 交易失败: ${error.message}`, 'error');
                    throw error;
                }
            } finally {
                this.isRunning = false;
                this.shouldStop = false;
            }
        }

        start() {
            if (this.isRunning) {
                log('交易已在运行中', 'warn');
                return;
            }

            if (!this.config.marketUrl) {
                log('请先配置市场链接', 'error');
                return;
            }

            // 检查是否在正确的页面
            if (!window.location.href.includes(this.config.marketUrl.replace('https://app.opinion.trade', ''))) {
                log(`正在跳转到市场页面: ${this.config.marketUrl}`, 'info');
                window.location.href = this.config.marketUrl;
                return;
            }

            this.executeTrade();
        }

        stop() {
            if (!this.isRunning) {
                log('交易未在运行中', 'warn');
                return;
            }

            log('正在停止交易...', 'info');
            this.shouldStop = true;
        }
    }

    // ==================== 配置面板 ====================
    function createConfigPanel() {
        const config = Config.getAll();

        const modal = document.createElement('div');
        modal.id = 'opinion-config-modal';
        modal.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 2147483647;
                display: flex;
                justify-content: center;
                align-items: center;
            ">
                <div style="
                    background: #ffffff;
                    padding: 40px;
                    border-radius: 12px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    max-width: 520px;
                    width: 90%;
                    max-height: 85vh;
                    overflow-y: auto;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                ">
                    <h2 style="
                        color: #1a1a1a;
                        margin: 0 0 30px 0;
                        font-size: 26px;
                        font-weight: 600;
                        letter-spacing: -0.5px;
                    ">⚙️ 交易配置</h2>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">市场链接</label>
                        <input type="text" id="cfg-marketUrl" value="${config.marketUrl}"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">选项名称</label>
                        <input type="text" id="cfg-optionName" value="${config.optionName}"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                        <div>
                            <label style="
                                color: #374151;
                                display: block;
                                margin-bottom: 8px;
                                font-weight: 500;
                                font-size: 14px;
                            ">交易金额</label>
                            <input type="number" id="cfg-tradeAmount" value="${config.tradeAmount}" min="0.01" step="0.01"
                                style="
                                    width: 100%;
                                    padding: 12px 14px;
                                    border: 2px solid #e5e7eb;
                                    border-radius: 8px;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                    box-sizing: border-box;
                                    background: #f9fafb;
                                    color: #1a1a1a;
                                "
                                onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                                onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                            >
                        </div>
                        <div>
                            <label style="
                                color: #374151;
                                display: block;
                                margin-bottom: 8px;
                                font-weight: 500;
                                font-size: 14px;
                            ">持仓时间(秒)</label>
                            <input type="number" id="cfg-holdTime" value="${config.holdTime}" min="1"
                                style="
                                    width: 100%;
                                    padding: 12px 14px;
                                    border: 2px solid #e5e7eb;
                                    border-radius: 8px;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                    box-sizing: border-box;
                                    background: #f9fafb;
                                    color: #1a1a1a;
                                "
                                onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                                onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                            >
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">交易方向</label>
                        <select id="cfg-tradeType"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                cursor: pointer;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                            <option value="YES" ${config.tradeType === 'YES' ? 'selected' : ''}>YES (买入看涨)</option>
                            <option value="NO" ${config.tradeType === 'NO' ? 'selected' : ''}>NO (买入看跌)</option>
                        </select>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">交易前等待(秒)</label>
                        <input type="number" id="cfg-waitBeforeTrade" value="${config.waitBeforeTrade}" min="0"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">卖出前等待(秒)</label>
                        <input type="number" id="cfg-sellWaitTime" value="${config.sellWaitTime}" min="0"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px;">
                        <label style="
                            color: #374151;
                            font-weight: 500;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            cursor: pointer;
                        ">
                            <input type="checkbox" id="cfg-autoStart" ${config.autoStart ? 'checked' : ''}
                                style="
                                    width: 18px;
                                    height: 18px;
                                    cursor: pointer;
                                    accent-color: #3b82f6;
                                "
                            >
                            自动开始交易
                        </label>

                        <label style="
                            color: #374151;
                            font-weight: 500;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            cursor: pointer;
                        ">
                            <input type="checkbox" id="cfg-enableLog" ${config.enableLog ? 'checked' : ''}
                                style="
                                    width: 18px;
                                    height: 18px;
                                    cursor: pointer;
                                    accent-color: #3b82f6;
                                "
                            >
                            启用详细日志
                        </label>
                    </div>

                    <div style="display: flex; gap: 12px; margin-top: 25px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                        <button id="cfg-save" style="
                            flex: 1;
                            background: #3b82f6;
                            color: white;
                            border: none;
                            padding: 14px 24px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 15px;
                            transition: all 0.2s;
                        " onmouseover="this.style.background='#2563eb';" onmouseout="this.style.background='#3b82f6';">保存配置</button>
                        <button id="cfg-cancel" style="
                            flex: 1;
                            background: #f3f4f6;
                            color: #374151;
                            border: 2px solid #e5e7eb;
                            padding: 14px 24px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 15px;
                            transition: all 0.2s;
                        " onmouseover="this.style.background='#e5e7eb';" onmouseout="this.style.background='#f3f4f6';">取消</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('cfg-save').addEventListener('click', () => {
            const newConfig = {
                marketUrl: document.getElementById('cfg-marketUrl').value,
                optionName: document.getElementById('cfg-optionName').value,
                tradeAmount: parseFloat(document.getElementById('cfg-tradeAmount').value),
                holdTime: parseInt(document.getElementById('cfg-holdTime').value),
                tradeType: document.getElementById('cfg-tradeType').value,
                waitBeforeTrade: parseInt(document.getElementById('cfg-waitBeforeTrade').value),
                sellWaitTime: parseInt(document.getElementById('cfg-sellWaitTime').value),
                autoStart: document.getElementById('cfg-autoStart').checked,
                enableLog: document.getElementById('cfg-enableLog').checked
            };

            Config.setAll(newConfig);
            log('✅ 配置已保存', 'success');
            modal.remove();
            alert('配置已保存!页面将刷新...');
            location.reload();
        });

        document.getElementById('cfg-cancel').addEventListener('click', () => {
            modal.remove();
        });

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // ==================== 控制面板 ====================
    // 更新按钮状态
    function updateTradeButton(isRunning) {
        const button = document.getElementById('start-trade');
        if (!button) return;

        if (isRunning) {
            button.textContent = '停止交易';
            button.style.background = '#ef4444';
            button.onmouseover = () => button.style.background = '#dc2626';
            button.onmouseout = () => button.style.background = '#ef4444';
        } else {
            button.textContent = '开始交易';
            button.style.background = '#3b82f6';
            button.onmouseover = () => button.style.background = '#2563eb';
            button.onmouseout = () => button.style.background = '#3b82f6';
        }
    }

    function createControlPanel() {
        try {
            log('正在创建控制面板...', 'info');

            // 检查是否已存在
            if (document.getElementById('opinion-auto-trader-panel')) {
                log('控制面板已存在,跳过创建', 'warn');
                return;
            }

            const panel = document.createElement('div');
            panel.id = 'opinion-auto-trader-panel';
            panel.innerHTML = `
                <div style="
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #ffffff;
                    padding: 16px 20px;
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                    z-index: 2147483646;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    min-width: 200px;
                    border: 1px solid #e5e7eb;
                ">
                    <div style="color: #1a1a1a; font-size: 15px; font-weight: 600; margin-bottom: 12px; letter-spacing: -0.3px;">
                        🤖 Opinion Auto Trader
                    </div>
                    <button id="start-trade" style="
                        background: #3b82f6;
                        color: white;
                        border: none;
                        padding: 10px 16px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        margin: 6px 0;
                        width: 100%;
                        transition: all 0.2s;
                    " onmouseover="this.style.background='#2563eb';" onmouseout="this.style.background='#3b82f6';">开始交易</button>
                    <button id="open-config" style="
                        background: #f3f4f6;
                        color: #374151;
                        border: 2px solid #e5e7eb;
                        padding: 10px 16px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        margin: 6px 0;
                        width: 100%;
                        transition: all 0.2s;
                    " onmouseover="this.style.background='#e5e7eb';" onmouseout="this.style.background='#f3f4f6';">配置</button>
                </div>
            `;

            // 等待 body 准备好
            const addToBody = () => {
                if (document.body) {
                    document.body.appendChild(panel);
                    log('✅ 控制面板已创建', 'success');

                    // 绑定事件
                    document.getElementById('start-trade').addEventListener('click', () => {
                        if (currentTrader && currentTrader.isRunning) {
                            // 停止交易
                            currentTrader.stop();
                            updateTradeButton(false);
                            currentTrader = null;
                        } else {
                            // 开始交易
                            const trader = new OpinionTrader();
                            currentTrader = trader;

                            // 监听交易状态变化
                            const originalExecuteTrade = trader.executeTrade.bind(trader);
                            trader.executeTrade = async function() {
                                try {
                                    updateTradeButton(true);
                                    await originalExecuteTrade();
                                } finally {
                                    updateTradeButton(false);
                                    if (currentTrader === trader) {
                                        currentTrader = null;
                                    }
                                }
                            };

                            trader.start();
                        }
                    });

                    document.getElementById('open-config').addEventListener('click', () => {
                        createConfigPanel();
                    });
                } else {
                    log('等待 body 元素...', 'warn');
                    setTimeout(addToBody, 100);
                }
            };

            addToBody();

        } catch (error) {
            log(`❌ 创建控制面板失败: ${error.message}`, 'error');
            console.error(error);
        }
    }

    // ==================== 初始化 ====================
    function init() {
        log('=== Opinion Auto Trader 已加载 ===', 'success');
        log('当前配置: ' + JSON.stringify(Config.getAll()), 'info');

        // 注册菜单命令
        GM_registerMenuCommand('⚙️ 打开配置', () => createConfigPanel());
        GM_registerMenuCommand('▶️ 开始交易', () => {
            const trader = new OpinionTrader();
            trader.start();
        });
        GM_registerMenuCommand('🔄 重置配置', () => {
            if (confirm('确定要重置所有配置吗?')) {
                Config.reset();
                log('配置已重置', 'success');
                alert('配置已重置!');
            }
        });

        // 创建控制面板
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createControlPanel);
        } else {
            createControlPanel();
        }

        // 自动开始
        if (Config.get('autoStart')) {
            log('自动开始已启用,准备执行交易...', 'info');
            const trader = new OpinionTrader();
            setTimeout(() => trader.start(), 2000);
        }
    }

    // 启动脚本
    init();

})();
