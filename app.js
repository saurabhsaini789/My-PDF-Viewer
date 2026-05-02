// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// IndexedDB Utils
const DB_NAME = 'PDFReaderDB';
const STORE_NAME = 'pdfStore';

function savePDFToDB(fileName, arrayBuffer) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
        request.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ name: fileName, data: arrayBuffer }, 'lastOpenedPDF');
            tx.oncomplete = () => resolve();
            tx.onerror = (err) => reject(err);
        };
    });
}

function loadPDFFromDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
        request.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) return resolve(null);
            const tx = db.transaction(STORE_NAME, 'readonly');
            const getReq = tx.objectStore(STORE_NAME).get('lastOpenedPDF');
            getReq.onsuccess = () => resolve(getReq.result);
            getReq.onerror = () => resolve(null);
        };
    });
}
class PDFReader {
    constructor() {
        this.pdfDoc = null;
        this.pageNum = 1;
        this.totalPages = 0;
        this.scale = 1.0;
        this.baseScale = 1.0;
        this.mode = 'scroll'; // 'scroll' or 'book'
        this.fileName = '';
        this.pagesText = []; 
        this.searchResults = [];
        this.currentSearchIndex = -1;
        this.isSearching = false;
        
        // Rendering State
        this.renderedPages = new Set();
        this.intersectionObserver = null;
        
        // UI Elements
        this.elements = {
            app: document.getElementById('app'),
            viewerWrapper: document.getElementById('viewer-wrapper'),
            viewer: document.getElementById('viewer'),
            emptyState: document.getElementById('empty-state'),
            fileInput: document.getElementById('file-input'),
            emptyFileInput: document.getElementById('empty-file-input'),
            fileNameLabel: document.getElementById('file-name'),
            prevBtn: document.getElementById('prev-btn'),
            nextBtn: document.getElementById('next-btn'),
            pageNumInput: document.getElementById('page-num'),
            pageCountSpan: document.getElementById('page-count'),
            progressBar: document.getElementById('progress-bar'),
            zoomInBtn: document.getElementById('zoom-in'),
            zoomOutBtn: document.getElementById('zoom-out'),
            zoomValSpan: document.getElementById('zoom-val'),
            modeToggle: document.getElementById('mode-toggle'),
            themeToggle: document.getElementById('theme-toggle'),
            fullscreenToggle: document.getElementById('fullscreen-toggle'),
            searchToggle: document.getElementById('search-toggle'),
            searchBar: document.getElementById('search-bar'),
            searchInput: document.getElementById('search-input'),
            searchControls: document.querySelector('.search-controls'),
            searchPrev: document.getElementById('search-prev'),
            searchNext: document.getElementById('search-next'),
            searchClose: document.getElementById('search-close'),
            searchResultsCount: document.getElementById('search-results-count'),
            loadingOverlay: document.getElementById('loading-overlay'),
            tapLeft: document.getElementById('tap-zone-left'),
            tapRight: document.getElementById('tap-zone-right'),
            progressText: document.getElementById('progress-text'),
            tocToggle: document.getElementById('toc-toggle'),
            sideDrawer: document.getElementById('side-drawer'),
            closeDrawer: document.getElementById('close-drawer'),
            tabToc: document.getElementById('tab-toc'),
            tabBookmarks: document.getElementById('tab-bookmarks'),
            tocView: document.getElementById('toc-view'),
            bookmarksView: document.getElementById('bookmarks-view'),
            bookmarkBtn: document.getElementById('bookmark-btn')
        };

        this.init();
    }

    init() {
        this.initTheme();
        this.attachEventListeners();
        this.initIntersectionObserver();
        
        loadPDFFromDB().then(pdfData => {
            if (pdfData && pdfData.data) {
                this.loadPDFArrayBuffer(pdfData.name, pdfData.data);
            }
        });
        
        // Handle window resize
        window.addEventListener('resize', () => {
            if (this.pdfDoc) {
                // Throttle resize
                clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => {
                    this.calculateBaseScale();
                    this.renderCurrentView();
                }, 200);
            }
        });
    }

    initTheme() {
        const savedTheme = localStorage.getItem('pdf-reader-theme');
        if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.body.setAttribute('data-theme', 'dark');
        } else {
            document.body.removeAttribute('data-theme');
        }
    }

    toggleTheme() {
        if (document.body.getAttribute('data-theme') === 'dark') {
            document.body.removeAttribute('data-theme');
            localStorage.setItem('pdf-reader-theme', 'light');
        } else {
            document.body.setAttribute('data-theme', 'dark');
            localStorage.setItem('pdf-reader-theme', 'dark');
        }
    }

    attachEventListeners() {
        // File Selection
        const handleFile = (e) => {
            const file = e.target.files[0];
            if (file && file.type === 'application/pdf') {
                this.openFile(file);
            }
        };
        this.elements.fileInput.addEventListener('change', handleFile);
        this.elements.emptyFileInput.addEventListener('change', handleFile);

        // Navigation
        this.elements.prevBtn.addEventListener('click', () => this.goToPage(this.pageNum - 1));
        this.elements.nextBtn.addEventListener('click', () => this.goToPage(this.pageNum + 1));
        this.elements.pageNumInput.addEventListener('change', (e) => {
            let num = parseInt(e.target.value);
            if (num >= 1 && num <= this.totalPages) {
                this.goToPage(num);
            } else {
                e.target.value = this.pageNum;
            }
        });

        // Zoom
        this.elements.zoomInBtn.addEventListener('click', () => this.setZoom(this.scale + 0.2));
        this.elements.zoomOutBtn.addEventListener('click', () => this.setZoom(this.scale - 0.2));

        // Mode & Theme
        this.elements.modeToggle.addEventListener('click', () => this.toggleMode());
        this.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
        
        // Fullscreen
        this.elements.fullscreenToggle.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => console.error(err));
            } else {
                document.exitFullscreen();
            }
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!this.pdfDoc || e.target.tagName === 'INPUT') return;
            
            if (e.key === 'ArrowLeft') {
                this.goToPage(this.pageNum - 1);
            } else if (e.key === 'ArrowRight' || e.key === ' ') {
                if (this.mode === 'book' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    this.goToPage(this.pageNum + 1);
                }
            }
        });

        // Mobile Tap Zones
        this.elements.tapLeft.addEventListener('click', () => {
            if (this.mode === 'book') this.goToPage(this.pageNum - 1);
        });
        this.elements.tapRight.addEventListener('click', () => {
            if (this.mode === 'book') this.goToPage(this.pageNum + 1);
        });

        // Immersive Mode: Tap Center to toggle UI
        this.elements.viewerWrapper.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
            // Check if tap was in the center 60% of the screen
            const width = window.innerWidth;
            if (e.clientX > width * 0.2 && e.clientX < width * 0.8) {
                this.elements.app.classList.toggle('ui-hidden');
            }
        });

        // Touch Gestures for Swipe and Pinch-to-Zoom
        let touchStartX = 0;
        let touchStartY = 0;
        let pinchDist = 0;
        let currentPinchScale = 1;

        this.elements.viewerWrapper.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                pinchDist = Math.hypot(
                    e.touches[0].pageX - e.touches[1].pageX,
                    e.touches[0].pageY - e.touches[1].pageY
                );
                currentPinchScale = 1;
            } else if (e.touches.length === 1) {
                touchStartX = e.touches[0].screenX;
                touchStartY = e.touches[0].screenY;
            }
        }, { passive: true });

        this.elements.viewerWrapper.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && pinchDist > 0) {
                const newDist = Math.hypot(
                    e.touches[0].pageX - e.touches[1].pageX,
                    e.touches[0].pageY - e.touches[1].pageY
                );
                currentPinchScale = newDist / pinchDist;
                this.elements.viewer.style.transform = `scale(${currentPinchScale})`;
            }
        }, { passive: true });

        this.elements.viewerWrapper.addEventListener('touchend', (e) => {
            if (pinchDist > 0 && e.touches.length < 2) {
                this.elements.viewer.style.transform = '';
                const finalScale = this.scale * currentPinchScale;
                this.setZoom(Math.max(0.5, Math.min(3.0, finalScale)));
                pinchDist = 0;
            } else if (e.touches.length === 0 && pinchDist === 0) {
                const touchEndX = e.changedTouches[0].screenX;
                const touchEndY = e.changedTouches[0].screenY;
                this.handleSwipeGesture(touchStartX, touchEndX, touchStartY, touchEndY);
            }
        }, { passive: true });

        // Search
        if (this.elements.searchToggle) {
            this.elements.searchToggle.addEventListener('click', () => {
                const isHidden = this.elements.searchBar.style.display === 'none';
                this.elements.searchBar.style.display = isHidden ? 'flex' : 'none';
                if (isHidden) this.elements.searchInput.focus();
            });
        }
        
        // Sidebar Drawer
        if (this.elements.tocToggle) {
            this.elements.tocToggle.addEventListener('click', () => {
                this.elements.sideDrawer.classList.add('open');
                this.renderOutline();
                this.renderBookmarks();
            });
            this.elements.closeDrawer.addEventListener('click', () => {
                this.elements.sideDrawer.classList.remove('open');
            });
            this.elements.tabToc.addEventListener('click', () => {
                this.elements.tabToc.classList.add('active');
                this.elements.tabBookmarks.classList.remove('active');
                this.elements.tocView.classList.add('active');
                this.elements.bookmarksView.classList.remove('active');
            });
            this.elements.tabBookmarks.addEventListener('click', () => {
                this.elements.tabBookmarks.classList.add('active');
                this.elements.tabToc.classList.remove('active');
                this.elements.bookmarksView.classList.add('active');
                this.elements.tocView.classList.remove('active');
            });
            this.elements.bookmarkBtn.addEventListener('click', () => this.toggleBookmark());
        }

        this.elements.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.performSearch(e.target.value);
            }
        });
        this.elements.searchInput.addEventListener('input', (e) => {
            if (e.target.value.length === 0) {
                this.clearSearch();
            }
        });
        this.elements.searchPrev.addEventListener('click', () => this.navigateSearch(-1));
        this.elements.searchNext.addEventListener('click', () => this.navigateSearch(1));
        this.elements.searchClose.addEventListener('click', () => {
            this.elements.searchInput.value = '';
            this.clearSearch();
            if (this.elements.searchBar) {
                this.elements.searchBar.style.display = 'none';
            }
        });

        // Scroll Tracking for Progress
        this.elements.viewerWrapper.addEventListener('scroll', () => {
            if (this.mode === 'scroll' && this.pdfDoc) {
                this.updateProgressOnScroll();
            }
        });
    }

    initIntersectionObserver() {
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const pageContainer = entry.target;
                const pageNum = parseInt(pageContainer.dataset.pageNumber);
                if (entry.isIntersecting) {
                    if (!this.renderedPages.has(pageNum)) {
                        this.renderPageCanvas(pageNum, pageContainer);
                    }
                } else {
                    // Virtualization: Clear far pages from memory
                    if (this.renderedPages.has(pageNum)) {
                        pageContainer.innerHTML = ''; 
                        this.renderedPages.delete(pageNum);
                    }
                }
            });
        }, {
            root: this.elements.viewerWrapper,
            rootMargin: '1000px 0px', // Buffer 
            threshold: 0
        });
    }

    showLoading(show) {
        if (show) {
            this.elements.loadingOverlay.classList.remove('hidden');
        } else {
            this.elements.loadingOverlay.classList.add('hidden');
        }
    }

    async openFile(file) {
        this.showLoading(true);

        const fileReader = new FileReader();
        fileReader.onload = async (e) => {
            const arrayBuffer = e.target.result;
            await savePDFToDB(file.name, arrayBuffer).catch(console.error);
            this.loadPDFArrayBuffer(file.name, arrayBuffer);
        };
        fileReader.readAsArrayBuffer(file);
    }

    async loadPDFArrayBuffer(fileName, arrayBuffer) {
        this.fileName = fileName;
        this.elements.fileNameLabel.textContent = fileName;
        this.elements.emptyState.style.display = 'none';
        this.showLoading(true);

        try {
            // Load PDF
            this.pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;
            this.totalPages = this.pdfDoc.numPages;
            
            // Enable UI
            this.enableUI();
            
            // Extract text for search in background
            this.extractText();
            
            // Check localStorage for saved page
            const savedPage = localStorage.getItem(`pdf_page_${this.fileName}`);
            this.pageNum = savedPage ? Math.min(Math.max(parseInt(savedPage), 1), this.totalPages) : 1;
            
            await this.calculateBaseScale();
            this.renderCurrentView();
            this.showLoading(false);
        } catch (error) {
            console.error("Error loading PDF:", error);
            alert("Error loading PDF file. Please try another file.");
            this.showLoading(false);
        }
    }

    enableUI() {
        const els = this.elements;
        els.prevBtn.disabled = false;
        els.nextBtn.disabled = false;
        els.pageNumInput.disabled = false;
        els.zoomInBtn.disabled = false;
        els.zoomOutBtn.disabled = false;
        els.modeToggle.disabled = false;
        if (els.searchToggle) els.searchToggle.disabled = false;
        if (els.tocToggle) els.tocToggle.disabled = false;
        if (els.bookmarkBtn) els.bookmarkBtn.disabled = false;
        els.searchInput.disabled = false;
        els.pageCountSpan.textContent = this.totalPages;
    }

    async calculateBaseScale() {
        if (!this.pdfDoc) return;
        const page = await this.pdfDoc.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });
        
        const containerWidth = this.elements.viewerWrapper.clientWidth;
        const containerHeight = this.elements.viewerWrapper.clientHeight;
        
        const padding = this.mode === 'book' ? 0 : 48; // padding for scroll mode
        
        if (this.mode === 'book') {
            // Fit to window height or width
            const scaleX = (containerWidth - 32) / viewport.width;
            const scaleY = (containerHeight - 32) / viewport.height;
            this.baseScale = Math.min(scaleX, scaleY);
        } else {
            // Fit to width
            this.baseScale = (containerWidth - padding) / viewport.width;
            // Cap at a reasonable max size
            if (viewport.width * this.baseScale > 1200) {
                this.baseScale = 1200 / viewport.width;
            }
        }
        
        // For mobile devices, don't let the scale get too small in scroll mode
        if (window.innerWidth <= 768 && this.mode === 'scroll') {
            this.baseScale = (window.innerWidth - 16) / viewport.width;
        }
        
        this.scale = 1.0; // Reset relative zoom
        this.updateZoomUI();
    }

    setZoom(newScale) {
        if (newScale < 0.5 || newScale > 3.0) return;
        this.scale = newScale;
        this.updateZoomUI();
        this.renderCurrentView();
    }

    updateZoomUI() {
        this.elements.zoomValSpan.textContent = `${Math.round(this.scale * 100)}%`;
    }

    toggleMode() {
        this.mode = this.mode === 'scroll' ? 'book' : 'scroll';
        
        // Update UI icons
        const icon = this.elements.modeToggle.querySelector('i');
        if (this.mode === 'book') {
            icon.className = 'fas fa-scroll';
            this.elements.modeToggle.title = 'Switch to Scroll Mode';
            this.elements.viewer.className = 'book-mode';
        } else {
            icon.className = 'fas fa-book-open';
            this.elements.modeToggle.title = 'Switch to Book Mode';
            this.elements.viewer.className = 'scroll-mode';
        }
        
        this.calculateBaseScale().then(() => {
            this.renderCurrentView();
        });
    }

    async renderCurrentView() {
        if (!this.pdfDoc) return;
        
        this.elements.viewer.innerHTML = ''; // Clear current view
        this.renderedPages.clear();
        this.intersectionObserver.disconnect();
        
        if (this.mode === 'book') {
            // Render single page
            const container = this.createPageContainer(this.pageNum);
            this.elements.viewer.appendChild(container);
            await this.renderPageCanvas(this.pageNum, container);
            this.updateUI();
        } else {
            // Scroll mode: Create placeholders for all pages
            // To ensure smooth scrolling, we need to set heights based on first page aspect ratio
            const page1 = await this.pdfDoc.getPage(1);
            const vp1 = page1.getViewport({ scale: this.baseScale * this.scale });
            const aspectRatio = vp1.height / vp1.width;
            
            for (let i = 1; i <= this.totalPages; i++) {
                const container = this.createPageContainer(i);
                // Approximate height to prevent scroll jumping
                container.style.width = `${vp1.width}px`;
                container.style.height = `${vp1.width * aspectRatio}px`;
                this.elements.viewer.appendChild(container);
                this.intersectionObserver.observe(container);
            }
            
            // Scroll to current page
            const targetContainer = document.getElementById(`page-container-${this.pageNum}`);
            if (targetContainer) {
                targetContainer.scrollIntoView();
            }
            this.updateUI();
        }
    }

    createPageContainer(pageNum) {
        const container = document.createElement('div');
        container.className = 'page-container';
        container.id = `page-container-${pageNum}`;
        container.dataset.pageNumber = pageNum;
        return container;
    }

    async renderPageCanvas(pageNum, container) {
        if (!this.pdfDoc) return;
        
        try {
            const page = await this.pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: this.baseScale * this.scale });
            
            // Update container size with exact dimensions
            container.style.width = `${viewport.width}px`;
            container.style.height = `${viewport.height}px`;
            
            // Create Canvas
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Handle high DPI displays
            const outputScale = window.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            
            const transform = outputScale !== 1 
                ? [outputScale, 0, 0, outputScale, 0, 0] 
                : null;
                
            container.appendChild(canvas);
            
            // Text layer for selection and search highlights
            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'text-layer';
            container.appendChild(textLayerDiv);
            
            const textContent = await page.getTextContent();
            const viewportTransform = viewport.transform;
            
            textContent.items.forEach(item => {
                const tx = item.transform;
                const x = tx[4] * viewportTransform[0] + tx[5] * viewportTransform[2] + viewportTransform[4];
                const y = tx[4] * viewportTransform[1] + tx[5] * viewportTransform[3] + viewportTransform[5];
                const fontHeight = Math.sqrt((tx[2]*tx[2]) + (tx[3]*tx[3])) * viewportTransform[3];
                
                const span = document.createElement('span');
                span.textContent = item.str + ' ';
                span.style.left = `${x}px`;
                span.style.top = `${y - Math.abs(fontHeight) * 0.8}px`; // baseline adjustment
                span.style.fontSize = `${Math.abs(fontHeight)}px`;
                textLayerDiv.appendChild(span);
            });
            
            const renderContext = {
                canvasContext: ctx,
                transform: transform,
                viewport: viewport
            };
            
            await page.render(renderContext).promise;
            this.renderedPages.add(pageNum);
            
            // If search is active, highlight on this newly rendered page
            if (this.isSearching && this.searchQuery) {
                this.highlightSearchOnPage(pageNum, container);
            }
            
        } catch (err) {
            console.error(`Error rendering page ${pageNum}:`, err);
        }
    }

    goToPage(num) {
        if (!this.pdfDoc) return;
        if (num < 1 || num > this.totalPages) return;
        
        this.pageNum = num;
        
        // Save to localStorage
        if (this.fileName) {
            localStorage.setItem(`pdf_page_${this.fileName}`, this.pageNum);
        }
        
        if (this.mode === 'book') {
            this.renderCurrentView();
        } else {
            const targetContainer = document.getElementById(`page-container-${this.pageNum}`);
            if (targetContainer) {
                targetContainer.scrollIntoView({ behavior: 'smooth' });
            }
            this.updateUI();
        }
    }

    updateUI() {
        this.elements.pageNumInput.value = this.pageNum;
        this.elements.prevBtn.disabled = this.pageNum <= 1;
        this.elements.nextBtn.disabled = this.pageNum >= this.totalPages;
        
        // Progress bar & text
        const progress = (this.pageNum / this.totalPages) * 100;
        this.elements.progressBar.style.width = `${progress}%`;
        
        const percentCompleted = Math.round(progress);
        const percentRemaining = 100 - percentCompleted;
        if (this.elements.progressText) {
            this.elements.progressText.textContent = `${percentCompleted}% completed (${percentRemaining}% remaining)`;
        }
        this.renderBookmarks(); // Updates bookmark button state
    }

    updateProgressOnScroll() {
        const wrapper = this.elements.viewerWrapper;
        const wrapperRect = wrapper.getBoundingClientRect();
        const centerViewY = wrapperRect.top + wrapperRect.height / 2;
        
        let minDistance = Infinity;
        let closestPageNum = this.pageNum;
        
        const containers = document.querySelectorAll('.page-container');
        containers.forEach(container => {
            const rect = container.getBoundingClientRect();
            // Calculate distance from center of container to center of view
            const centerContainerY = rect.top + rect.height / 2;
            const distance = Math.abs(centerContainerY - centerViewY);
            
            if (distance < minDistance) {
                minDistance = distance;
                closestPageNum = parseInt(container.dataset.pageNumber);
            }
        });
        
        if (closestPageNum !== this.pageNum) {
            this.pageNum = closestPageNum;
            this.updateUI();
            if (this.fileName) {
                localStorage.setItem(`pdf_page_${this.fileName}`, this.pageNum);
            }
        }
    }

    handleSwipeGesture(startX, endX, startY, endY) {
        // Only swipe in book mode when not zoomed in
        if (this.mode !== 'book' || this.scale > 1.0) return; 
        
        const deltaX = endX - startX;
        const deltaY = endY - startY;
        
        // Require horizontal swipe to be more significant than vertical movement
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 40) {
            if (deltaX < 0) {
                this.goToPage(this.pageNum + 1); // Swipe left -> next page
            } else {
                this.goToPage(this.pageNum - 1); // Swipe right -> prev page
            }
        }
    }

    // --- Search Functionality --- //
    
    async renderOutline() {
        if (!this.pdfDoc) return;
        const outline = await this.pdfDoc.getOutline();
        this.elements.tocView.innerHTML = '';
        if (!outline || outline.length === 0) {
            this.elements.tocView.innerHTML = '<p style="opacity:0.6;">No document outline found.</p>';
            return;
        }
        
        const renderItem = (item, container, level) => {
            const div = document.createElement('div');
            div.className = 'toc-item';
            div.style.paddingLeft = `${level * 12}px`;
            div.textContent = item.title;
            div.addEventListener('click', async () => {
                const dest = typeof item.dest === 'string' ? await this.pdfDoc.getDestination(item.dest) : item.dest;
                if (dest) {
                    const pageIndex = await this.pdfDoc.getPageIndex(dest[0]);
                    this.goToPage(pageIndex + 1);
                    this.elements.sideDrawer.classList.remove('open');
                }
            });
            container.appendChild(div);
            if (item.items && item.items.length > 0) {
                item.items.forEach(child => renderItem(child, container, level + 1));
            }
        };
        
        outline.forEach(item => renderItem(item, this.elements.tocView, 0));
    }

    toggleBookmark() {
        const bookmarksStr = localStorage.getItem(`pdf_bookmarks_${this.fileName}`) || '[]';
        let bookmarks = JSON.parse(bookmarksStr);
        if (bookmarks.includes(this.pageNum)) {
            bookmarks = bookmarks.filter(p => p !== this.pageNum);
        } else {
            bookmarks.push(this.pageNum);
            bookmarks.sort((a,b)=>a-b);
        }
        localStorage.setItem(`pdf_bookmarks_${this.fileName}`, JSON.stringify(bookmarks));
        this.renderBookmarks();
    }

    renderBookmarks() {
        if (!this.elements.bookmarksView || !this.fileName) return;
        const bookmarksStr = localStorage.getItem(`pdf_bookmarks_${this.fileName}`) || '[]';
        const bookmarks = JSON.parse(bookmarksStr);
        this.elements.bookmarksView.innerHTML = '';
        
        // update button state
        if (this.elements.bookmarkBtn) {
            this.elements.bookmarkBtn.querySelector('i').className = bookmarks.includes(this.pageNum) ? 'fas fa-bookmark' : 'far fa-bookmark';
        }
        
        if (bookmarks.length === 0) {
            this.elements.bookmarksView.innerHTML = '<p style="opacity:0.6;">No bookmarks saved yet.</p>';
            return;
        }
        bookmarks.forEach(page => {
            const div = document.createElement('div');
            div.className = 'bookmark-item';
            div.textContent = `Bookmark - Page ${page}`;
            div.addEventListener('click', () => {
                this.goToPage(page);
                this.elements.sideDrawer.classList.remove('open');
            });
            this.elements.bookmarksView.appendChild(div);
        });
    }

    async extractText() {
        this.pagesText = [];
        for (let i = 1; i <= this.totalPages; i++) {
            const page = await this.pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            this.pagesText.push(textContent.items);
        }
    }

    performSearch(query) {
        query = query.trim().toLowerCase();
        if (!query) {
            this.clearSearch();
            return;
        }

        this.searchQuery = query;
        this.searchResults = [];
        this.isSearching = true;

        // Find all matches
        for (let i = 0; i < this.pagesText.length; i++) {
            const pageItems = this.pagesText[i];
            const pageNum = i + 1;
            
            pageItems.forEach((item, itemIndex) => {
                const text = item.str.toLowerCase();
                if (text.includes(query)) {
                    this.searchResults.push({
                        pageNum,
                        itemIndex,
                        item,
                        originalText: item.str
                    });
                }
            });
        }

        if (this.searchResults.length > 0) {
            this.currentSearchIndex = 0;
            this.updateSearchUI();
            this.jumpToSearchResult();
        } else {
            this.elements.searchResultsCount.textContent = '0/0';
        }
        
        // Re-render currently visible pages to show highlights
        this.refreshVisibleHighlights();
    }

    navigateSearch(direction) {
        if (this.searchResults.length === 0) return;
        
        this.currentSearchIndex += direction;
        if (this.currentSearchIndex < 0) {
            this.currentSearchIndex = this.searchResults.length - 1;
        } else if (this.currentSearchIndex >= this.searchResults.length) {
            this.currentSearchIndex = 0;
        }
        
        this.updateSearchUI();
        this.jumpToSearchResult();
        this.refreshVisibleHighlights();
    }

    updateSearchUI() {
        this.elements.searchResultsCount.textContent = `${this.currentSearchIndex + 1}/${this.searchResults.length}`;
    }

    clearSearch() {
        this.isSearching = false;
        this.searchQuery = '';
        this.searchResults = [];
        this.currentSearchIndex = -1;
        this.elements.searchInput.value = '';
        this.elements.searchResultsCount.textContent = '0/0';
        
        // Remove all highlight divs
        const layers = document.querySelectorAll('.text-layer');
        layers.forEach(layer => layer.innerHTML = '');
    }

    jumpToSearchResult() {
        const result = this.searchResults[this.currentSearchIndex];
        if (result.pageNum !== this.pageNum) {
            this.goToPage(result.pageNum);
        } else if (this.mode === 'scroll') {
            // Scroll to the specific highlight if already on the page
            // Give it a tiny delay to ensure rendering if it was lazy loaded
            setTimeout(() => {
                const activeHighlight = document.querySelector('.highlight.active');
                if (activeHighlight) {
                    activeHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        }
    }

    refreshVisibleHighlights() {
        if (!this.isSearching) return;
        
        const containers = document.querySelectorAll('.page-container');
        containers.forEach(container => {
            const pageNum = parseInt(container.dataset.pageNumber);
            if (this.renderedPages.has(pageNum)) {
                this.highlightSearchOnPage(pageNum, container);
            }
        });
    }

    async highlightSearchOnPage(pageNum, container) {
        const textLayer = container.querySelector('.text-layer');
        if (!textLayer) return;
        
        textLayer.innerHTML = ''; // clear old highlights
        
        const pageMatches = this.searchResults.filter(r => r.pageNum === pageNum);
        if (pageMatches.length === 0) return;

        const page = await this.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: this.baseScale * this.scale });

        pageMatches.forEach(match => {
            // Calculate approximate bounds
            // pdf.js item.transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
            const transform = match.item.transform;
            const tx = [transform[0], transform[1], transform[2], transform[3], transform[4], transform[5]];
            
            // Map to viewport
            const viewportTransform = viewport.transform;
            const x = tx[4] * viewportTransform[0] + tx[5] * viewportTransform[2] + viewportTransform[4];
            const y = tx[4] * viewportTransform[1] + tx[5] * viewportTransform[3] + viewportTransform[5];
            
            // Item height/width (approximate using scale factors and width)
            const fontHeight = Math.sqrt((tx[2]*tx[2]) + (tx[3]*tx[3])) * viewportTransform[3]; // scaleY * viewportScaleY
            const width = match.item.width * viewportTransform[0];
            
            const highlightDiv = document.createElement('div');
            highlightDiv.className = 'highlight';
            
            // Check if this is the currently active search result
            const isActive = this.searchResults.indexOf(match) === this.currentSearchIndex;
            if (isActive) {
                highlightDiv.classList.add('active');
            }
            
            highlightDiv.style.left = `${x}px`;
            // PDF coordinates: Y goes up, viewport coordinates: Y goes down
            // The y coordinate we computed is the baseline. 
            // We need to adjust top position.
            highlightDiv.style.top = `${y - Math.abs(fontHeight) * 0.8}px`; 
            highlightDiv.style.width = `${width}px`;
            highlightDiv.style.height = `${Math.abs(fontHeight)}px`;
            
            textLayer.appendChild(highlightDiv);
        });
    }
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    window.pdfApp = new PDFReader();
});
