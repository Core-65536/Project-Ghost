/**
 * Lightweight Readability Implementation
 * Based on Mozilla's Readability algorithm principles
 * 
 * This is a simplified version optimized for Chrome extension content extraction
 */

(function(global) {
    'use strict';

    // Unlikely candidates regex
    const UNLIKELY_CANDIDATES = /banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|foot|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-hierarchical|tooltip/i;
    
    // Maybe candidates
    const MAYBE_CANDIDATES = /and|article|body|column|main|shadow|content/i;
    
    // Positive score indicators
    const POSITIVE_SCORE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
    
    // Negative score indicators
    const NEGATIVE_SCORE = /hidden|^hid$|hid$|hid|^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i;

    // Block elements that should have line breaks
    const BLOCK_ELEMENTS = new Set([
        'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CANVAS', 
        'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 
        'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 
        'HR', 'LI', 'MAIN', 'NAV', 'NOSCRIPT', 'OL', 'P', 'PRE', 
        'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 
        'TR', 'UL', 'VIDEO'
    ]);

    // Elements to remove completely
    const REMOVE_ELEMENTS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
        'SVG', 'CANVAS', 'TEMPLATE', 'AUDIO', 'VIDEO', 'FORM',
        'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'
    ]);

    class Readability {
        constructor(doc, options = {}) {
            this.doc = doc;
            this.options = options;
            this.candidates = [];
        }

        parse() {
            // Clone the document to avoid modifying the original
            const docClone = this.doc.cloneNode(true);
            
            // Remove unwanted elements
            this._removeUnwanted(docClone);
            
            // Get metadata
            const metadata = this._getMetadata(docClone);
            
            // Find the main content
            const content = this._grabArticle(docClone);
            
            return {
                title: metadata.title || this.doc.title,
                content: content,
                textContent: this._getTextContent(content),
                excerpt: metadata.excerpt,
                byline: metadata.byline,
            };
        }

        _removeUnwanted(doc) {
            // Remove script, style, etc.
            REMOVE_ELEMENTS.forEach(tag => {
                const elements = doc.getElementsByTagName(tag);
                while (elements.length > 0) {
                    elements[0].parentNode?.removeChild(elements[0]);
                }
            });

            // Remove hidden elements
            const allElements = doc.querySelectorAll('*');
            allElements.forEach(el => {
                if (el.getAttribute('hidden') !== null ||
                    el.getAttribute('aria-hidden') === 'true' ||
                    (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden'))) {
                    el.parentNode?.removeChild(el);
                }
            });
        }

        _getMetadata(doc) {
            const metadata = {
                title: '',
                excerpt: '',
                byline: ''
            };

            // Try different title sources
            const titleEl = doc.querySelector('h1') || 
                           doc.querySelector('[class*="title"]') ||
                           doc.querySelector('title');
            if (titleEl) {
                metadata.title = titleEl.textContent?.trim();
            }

            // Get description from meta tags
            const descMeta = doc.querySelector('meta[name="description"]') ||
                            doc.querySelector('meta[property="og:description"]');
            if (descMeta) {
                metadata.excerpt = descMeta.getAttribute('content');
            }

            // Get author
            const authorMeta = doc.querySelector('meta[name="author"]') ||
                              doc.querySelector('[rel="author"]');
            if (authorMeta) {
                metadata.byline = authorMeta.getAttribute('content') || authorMeta.textContent;
            }

            return metadata;
        }

        _grabArticle(doc) {
            // First, try semantic elements
            const semanticContent = doc.querySelector('article') ||
                                   doc.querySelector('main') ||
                                   doc.querySelector('[role="main"]') ||
                                   doc.querySelector('[role="article"]');
            
            if (semanticContent && this._getInnerTextLength(semanticContent) > 200) {
                return semanticContent;
            }

            // Score all elements
            const allElements = doc.querySelectorAll('div, section, article, p, td, pre');
            const candidates = [];

            for (const element of allElements) {
                const innerText = this._getInnerText(element);
                const innerTextLen = innerText.length;

                // Skip if too short
                if (innerTextLen < 25) continue;

                // Initialize score
                let score = 0;

                // Add points for having paragraphs
                score += element.querySelectorAll('p').length;

                // Add points for text length
                score += Math.min(Math.floor(innerTextLen / 100), 3);

                // Class/id scoring
                const classAndId = (element.className + ' ' + element.id).toLowerCase();
                if (POSITIVE_SCORE.test(classAndId)) score += 25;
                if (NEGATIVE_SCORE.test(classAndId)) score -= 25;
                if (UNLIKELY_CANDIDATES.test(classAndId)) score -= 20;
                if (MAYBE_CANDIDATES.test(classAndId)) score += 5;

                // Link density penalty
                const linkLen = [...element.querySelectorAll('a')]
                    .reduce((sum, a) => sum + (a.textContent?.length || 0), 0);
                const linkDensity = innerTextLen > 0 ? linkLen / innerTextLen : 0;
                score = score * (1 - linkDensity);

                candidates.push({ element, score, textLen: innerTextLen });
            }

            // Sort by score
            candidates.sort((a, b) => b.score - a.score);

            // Return the best candidate
            if (candidates.length > 0 && candidates[0].score > 0) {
                return candidates[0].element;
            }

            // Fallback to body
            return doc.body;
        }

        _getInnerText(el) {
            return el.textContent?.trim() || '';
        }

        _getInnerTextLength(el) {
            return this._getInnerText(el).length;
        }

        _getTextContent(el) {
            if (!el) return '';
            
            const walk = (node, result) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent?.trim();
                    if (text) result.push(text);
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    // Add line break before block elements
                    if (BLOCK_ELEMENTS.has(node.tagName)) {
                        result.push('\n');
                    }
                    
                    for (const child of node.childNodes) {
                        walk(child, result);
                    }
                    
                    // Add line break after block elements
                    if (BLOCK_ELEMENTS.has(node.tagName)) {
                        result.push('\n');
                    }
                }
            };
            
            const parts = [];
            walk(el, parts);
            
            return parts.join(' ')
                .replace(/\s+/g, ' ')
                .replace(/\n\s*\n/g, '\n\n')
                .trim();
        }
    }

    // Export
    global.Readability = Readability;

})(typeof window !== 'undefined' ? window : this);
