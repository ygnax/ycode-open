'use client';

/**
 * Center Canvas - Preview Area with Isolated Iframe
 *
 * Shows live preview of the website being built using Tailwind JIT CDN
 */

// 1. React/Next.js
import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';

// 2. External libraries
import { ArrowLeft } from 'lucide-react';

// 3. ShadCN UI
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';

// 5. Stores
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorUrl } from '@/hooks/use-editor-url';

// 6. Utils
import { sendToIframe, listenToIframe, serializeLayers } from '@/lib/iframe-bridge';
import type { IframeToParentMessage } from '@/lib/iframe-bridge';
import { buildPageTree, getNodeIcon, findHomepage } from '@/lib/page-utils';
import type { PageTreeNode } from '@/lib/page-utils';
import { cn } from '@/lib/utils';

// 7. Types
import type { Layer, Page, PageFolder } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

type ViewportMode = 'desktop' | 'tablet' | 'mobile';

interface CenterCanvasProps {
  selectedLayerId: string | null;
  currentPageId: string | null;
  viewportMode: ViewportMode;
  setViewportMode: (mode: ViewportMode) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
}

const viewportSizes: Record<ViewportMode, { width: string; label: string; icon: string }> = {
  desktop: { width: '1366px', label: 'Desktop', icon: '🖥️' },
  tablet: { width: '768px', label: 'Tablet', icon: '📱' },
  mobile: { width: '375px', label: 'Mobile', icon: '📱' },
};

const CenterCanvas = React.memo(function CenterCanvas({
  selectedLayerId,
  currentPageId,
  viewportMode,
  setViewportMode,
  zoom,
  setZoom,
}: CenterCanvasProps) {
  const [showAddBlockPanel, setShowAddBlockPanel] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const [pagePopoverOpen, setPagePopoverOpen] = useState(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(new Set());
  const [isPanning, setIsPanning] = useState(false);
  const [iframeHeight, setIframeHeight] = useState<number | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  
  // Transform-based zoom and pan state (Framer-style)
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const desktopIframeRef = useRef<HTMLIFrameElement>(null);
  const tabletIframeRef = useRef<HTMLIFrameElement>(null);
  const mobileIframeRef = useRef<HTMLIFrameElement>(null);
  const transformLayerRef = useRef<HTMLDivElement>(null);
  
  // Refs to avoid stale closures in event handlers
  const panXRef = useRef(0);
  const panYRef = useRef(0);
  const zoomRef = useRef(100);

  // Calculate dimensions for scrollable area when zoomed
  const { wrapperWidth, wrapperHeight } = useMemo(() => {
    const viewportWidth = parseInt(viewportSizes[viewportMode].width);
    const viewportHeight = iframeHeight || 600;
    const padding = 64; // 32px on each side (p-8)
    
    // Calculate scaled dimensions
    const scaledWidth = viewportWidth * (zoom / 100);
    const scaledHeight = viewportHeight * (zoom / 100);
    
    // Add padding to the scaled dimensions
    return {
      wrapperWidth: scaledWidth + padding,
      wrapperHeight: scaledHeight + padding,
    };
  }, [viewportMode, zoom, iframeHeight]);

  // Optimize store subscriptions - use selective selectors
  const draftsByPageId = usePagesStore((state) => state.draftsByPageId);
  const addLayerFromTemplate = usePagesStore((state) => state.addLayerFromTemplate);
  const updateLayer = usePagesStore((state) => state.updateLayer);
  const pages = usePagesStore((state) => state.pages);
  const folders = usePagesStore((state) => state.folders);

  const setSelectedLayerId = useEditorStore((state) => state.setSelectedLayerId);
  const activeUIState = useEditorStore((state) => state.activeUIState);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const setCurrentPageId = useEditorStore((state) => state.setCurrentPageId);
  const returnToPageId = useEditorStore((state) => state.returnToPageId);
  const currentPageCollectionItemId = useEditorStore((state) => state.currentPageCollectionItemId);
  const setCurrentPageCollectionItemId = useEditorStore((state) => state.setCurrentPageCollectionItemId);

  const getDropdownItems = useCollectionsStore((state) => state.getDropdownItems);
  const collectionItemsFromStore = useCollectionsStore((state) => state.items);
  const collectionsFromStore = useCollectionsStore((state) => state.collections);
  const collectionFieldsFromStore = useCollectionsStore((state) => state.fields);

  const { routeType, urlState, navigateToLayers, navigateToPage, navigateToPageEdit } = useEditorUrl();
  const components = useComponentsStore((state) => state.components);
  const componentDrafts = useComponentsStore((state) => state.componentDrafts);
  const [collectionItems, setCollectionItems] = useState<Array<{ id: string; label: string }>>([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  const layers = useMemo(() => {
    // If editing a component, show component layers
    if (editingComponentId) {
      return componentDrafts[editingComponentId] || [];
    }

    // Otherwise show page layers
    if (!currentPageId) {
      return [];
    }

    const draft = draftsByPageId[currentPageId];
    return draft ? draft.layers : [];
  }, [editingComponentId, componentDrafts, currentPageId, draftsByPageId]);

  // Separate regular pages from error pages
  const { regularPages, errorPages } = useMemo(() => {
    const regular = pages.filter(page => page.error_page === null);
    const errors = pages
      .filter(page => page.error_page !== null)
      .sort((a, b) => (a.error_page || 0) - (b.error_page || 0));
    return { regularPages: regular, errorPages: errors };
  }, [pages]);

  // Build page tree for navigation (only with regular pages)
  const pageTree = useMemo(() => buildPageTree(regularPages, folders), [regularPages, folders]);

  // Create virtual "Error pages" folder node
  const errorPagesNode: PageTreeNode | null = useMemo(() => {
    if (errorPages.length === 0) return null;

    const virtualFolder: PageFolder = {
      id: 'virtual-error-pages-folder',
      name: 'Error pages',
      slug: 'error-pages',
      page_folder_id: null,
      depth: 0,
      order: 999999,
      settings: {},
      is_published: false,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const errorPageNodes: PageTreeNode[] = errorPages.map(page => ({
      id: page.id,
      type: 'page',
      data: page,
      children: [],
    }));

    return {
      id: virtualFolder.id,
      type: 'folder',
      data: virtualFolder,
      children: errorPageNodes,
    };
  }, [errorPages]);

  // Get current page name and icon
  const currentPage = useMemo(() => pages.find(p => p.id === currentPageId), [pages, currentPageId]);
  const currentPageName = currentPage?.name || 'Loading...';
  const currentPageIcon = useMemo(() => {
    if (!currentPage) return 'homepage';
    const node: PageTreeNode = {
      id: currentPage.id,
      type: 'page',
      data: currentPage,
      children: []
    };
    return getNodeIcon(node);
  }, [currentPage]);

  // Get collection ID from current page if it's dynamic
  const collectionId = useMemo(() => {
    if (!currentPage?.is_dynamic) return null;
    return currentPage.settings?.cms?.collection_id || null;
  }, [currentPage]);

  // Load collection items when dynamic page is selected
  useEffect(() => {
    if (!collectionId || !currentPage?.is_dynamic) {
      setCollectionItems([]);
      setIsLoadingItems(false);
      return;
    }

    const loadItems = async () => {
      setIsLoadingItems(true);
      try {
        const itemsWithLabels = await getDropdownItems(collectionId);
        setCollectionItems(itemsWithLabels);
        // Auto-select first item if none selected
        if (!currentPageCollectionItemId && itemsWithLabels.length > 0) {
          setCurrentPageCollectionItemId(itemsWithLabels[0].id);
        }
      } catch (error) {
        console.error('Failed to load collection items:', error);
      } finally {
        setIsLoadingItems(false);
      }
    };

    loadItems();
  }, [collectionId, currentPage?.is_dynamic, getDropdownItems]);

  // Get return page for component edit mode
  const returnToPage = useMemo(() => {
    return returnToPageId ? pages.find(p => p.id === returnToPageId) : null;
  }, [returnToPageId, pages]);

  // Exit component edit mode handler
  const handleExitComponentEditMode = useCallback(async () => {
    const { setEditingComponentId } = useEditorStore.getState();
    const { saveComponentDraft, clearComponentDraft } = useComponentsStore.getState();
    const { updateComponentOnLayers } = usePagesStore.getState();

    if (!editingComponentId) return;

    // Save component draft
    await saveComponentDraft(editingComponentId);

    // Get the updated component
    const updatedComponent = useComponentsStore.getState().getComponentById(editingComponentId);
    if (updatedComponent) {
      // Update all instances across pages
      await updateComponentOnLayers(editingComponentId, updatedComponent.layers);
    }

    // Clear component draft
    clearComponentDraft(editingComponentId);

    // Determine which page to navigate to
    let targetPageId = returnToPageId;
    if (!targetPageId) {
      // No return page - use homepage
      const homePage = findHomepage(pages);
      const defaultPage = homePage || pages[0];
      targetPageId = defaultPage?.id || null;
    }

    // IMPORTANT: Navigate FIRST, then clear state
    // This ensures the navigation happens before component unmounts
    if (targetPageId) {
      // Navigate to the target page
      navigateToLayers(targetPageId);

      // Small delay to ensure navigation starts before clearing state
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Exit edit mode
    setEditingComponentId(null, null);

    // Clear selection
    setSelectedLayerId(null);
  }, [editingComponentId, returnToPageId, pages, setSelectedLayerId, navigateToLayers]);

  // Initialize all folders as collapsed on mount (including virtual error pages folder)
  useEffect(() => {
    const allFolderIds = new Set(folders.map(f => f.id));
    // Also collapse the virtual error pages folder by default
    allFolderIds.add('virtual-error-pages-folder');
    setCollapsedFolderIds(allFolderIds);
  }, [folders]);

  // Toggle folder collapse state
  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolderIds(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // Handle page selection
  const handlePageSelect = useCallback((pageId: string) => {
    setCurrentPageId(pageId);
    setPagePopoverOpen(false);

    // Navigate to the same route type but with the new page ID
    if (routeType === 'layers') {
      navigateToLayers(pageId);
    } else if (routeType === 'page' && urlState.isEditing) {
      navigateToPageEdit(pageId);
    } else if (routeType === 'page') {
      navigateToPage(pageId);
    } else {
      // Default to layers if no route type
      navigateToLayers(pageId);
    }
  }, [setCurrentPageId, routeType, urlState.isEditing, navigateToLayers, navigateToPage, navigateToPageEdit]);

  // Render page tree recursively
  const renderPageTreeNode = useCallback((node: PageTreeNode, depth: number = 0) => {
    const isFolder = node.type === 'folder';
    const isCollapsed = isFolder && collapsedFolderIds.has(node.id);
    const isCurrentPage = !isFolder && node.id === currentPageId;
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={node.id}>
        <div
          onClick={() => {
            if (isFolder) {
              toggleFolder(node.id);
            } else {
              handlePageSelect(node.id);
            }
          }}
          className={cn(
            "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-1.25 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
            isCurrentPage && 'bg-secondary/50'
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          {/* Expand/Collapse Button */}
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isFolder) {
                  toggleFolder(node.id);
                }
              }}
              className={cn(
                'size-3 flex items-center justify-center flex-shrink-0',
                isCollapsed ? '' : 'rotate-90'
              )}
            >
              <Icon name="chevronRight" className={cn('size-2.5 opacity-50', isCurrentPage && 'opacity-80')} />
            </button>
          ) : (
            <div className="size-3 flex-shrink-0 flex items-center justify-center">
              <div className={cn('ml-0.25 w-1.5 h-px bg-white opacity-0', isCurrentPage && 'opacity-0')} />
            </div>
          )}

          {/* Icon */}
          <Icon
            name={getNodeIcon(node)}
            className={cn('size-3 mr-0.5', isCurrentPage ? 'opacity-90' : 'opacity-50')}
          />

          {/* Label */}
          <span className="flex-grow text-xs font-medium overflow-hidden text-ellipsis whitespace-nowrap pointer-events-none">
            {isFolder ? (node.data as PageFolder).name : (node.data as Page).name}
          </span>

          {/* Check indicator */}
          {isCurrentPage && (
            <span className="absolute right-2 flex size-3.5 items-center justify-center">
              <Icon name="check" className="size-3 opacity-50" />
            </span>
          )}

        </div>
        {isFolder && !isCollapsed && node.children && (
          <div>
            {node.children.map(child => renderPageTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [collapsedFolderIds, currentPageId, toggleFolder, handlePageSelect]);

  // Helper function to send messages to all iframes
  const sendToAllIframes = useCallback((message: any) => {
    if (desktopIframeRef.current) {
      sendToIframe(desktopIframeRef.current, message);
    }
    if (tabletIframeRef.current) {
      sendToIframe(tabletIframeRef.current, message);
    }
    if (mobileIframeRef.current) {
      sendToIframe(mobileIframeRef.current, message);
    }
  }, []);

  // Send layers to all iframes whenever they change
  useEffect(() => {
    if (!iframeReady) return;

    const { layers: serializedLayers, componentMap } = serializeLayers(layers, components);
    sendToAllIframes({
      type: 'UPDATE_LAYERS',
      payload: {
        layers: serializedLayers,
        selectedLayerId,
        componentMap,
        editingComponentId: editingComponentId || null,
        collectionItems: collectionItemsFromStore,
        collectionFields: collectionFieldsFromStore,
      },
    });
  }, [layers, selectedLayerId, iframeReady, components, editingComponentId, collectionItemsFromStore, collectionFieldsFromStore, sendToAllIframes]);

  // Send breakpoint updates to each iframe (each iframe shows its own breakpoint)
  useEffect(() => {
    if (!iframeReady) return;

    // Send desktop breakpoint to desktop iframe
    if (desktopIframeRef.current) {
      sendToIframe(desktopIframeRef.current, {
        type: 'UPDATE_BREAKPOINT',
        payload: { breakpoint: 'desktop' },
      });
    }

    // Send tablet breakpoint to tablet iframe
    if (tabletIframeRef.current) {
      sendToIframe(tabletIframeRef.current, {
        type: 'UPDATE_BREAKPOINT',
        payload: { breakpoint: 'tablet' },
      });
    }

    // Send mobile breakpoint to mobile iframe
    if (mobileIframeRef.current) {
      sendToIframe(mobileIframeRef.current, {
        type: 'UPDATE_BREAKPOINT',
        payload: { breakpoint: 'mobile' },
      });
    }
  }, [iframeReady]);

  // Send UI state updates to all iframes
  useEffect(() => {
    if (!iframeReady) return;

    sendToAllIframes({
      type: 'UPDATE_UI_STATE',
      payload: { uiState: activeUIState },
    });
  }, [activeUIState, iframeReady, sendToAllIframes]);

  // Listen for messages from iframe
  useEffect(() => {
    const handleIframeMessage = (message: IframeToParentMessage) => {

      switch (message.type) {
        case 'READY':
          setIframeReady(true);
          break;

        case 'LAYER_CLICK':
          setSelectedLayerId(message.payload.layerId);
          break;

        case 'LAYER_DOUBLE_CLICK':
          // Text editing is handled inside iframe
          break;

        case 'TEXT_CHANGE_START':
          break;

        case 'TEXT_CHANGE_END':
          if (editingComponentId) {
            // Update layer in component draft
            const { updateComponentDraft } = useComponentsStore.getState();
            const currentDraft = componentDrafts[editingComponentId] || [];

            // Helper to update a layer in the tree
            const updateLayerInTree = (layers: Layer[], layerId: string, updates: Partial<Layer>): Layer[] => {
              return layers.map(layer => {
                if (layer.id === layerId) {
                  return { ...layer, ...updates };
                }
                if (layer.children) {
                  return { ...layer, children: updateLayerInTree(layer.children, layerId, updates) };
                }
                return layer;
              });
            };

            const updatedLayers = updateLayerInTree(currentDraft, message.payload.layerId, {
              text: message.payload.text,
              content: message.payload.text,
            });

            updateComponentDraft(editingComponentId, updatedLayers);
          } else if (currentPageId) {
            // Update layer in page draft
            updateLayer(currentPageId, message.payload.layerId, {
              text: message.payload.text,
              content: message.payload.text,
            });
          }
          break;

        case 'CONTEXT_MENU':
          // Context menu will be handled later
          break;

        case 'CONTENT_HEIGHT':
          setIframeHeight(message.payload.height);
          break;

        case 'DRAG_START':
        case 'DRAG_OVER':
        case 'DROP':
          // Drag-and-drop will be handled later
          break;
      }
    };

    const cleanup = listenToIframe(handleIframeMessage);
    return cleanup;
  }, [currentPageId, editingComponentId, componentDrafts, setSelectedLayerId, updateLayer]);

  // Zoom handlers with transform-based approach
  const handleZoomIn = useCallback(() => {
    const newZoom = Math.min(zoom + 10, 1000); // Max 1000%
    setZoom(newZoom);
  }, [zoom, setZoom]);

  const handleZoomOut = useCallback(() => {
    const newZoom = Math.max(zoom - 10, 10); // Min 10%
    setZoom(newZoom);
  }, [zoom, setZoom]);

  const handleZoomTo100 = useCallback(() => {
    setZoom(100);
    // Reset pan position when going to 100%
    setPanX(0);
    setPanY(0);
  }, [setZoom]);

  const handleZoomToFit = useCallback(() => {
    // Zoom to Fit - fits vertically and centers the canvas
    const container = canvasContainerRef.current;
    if (container) {
      const containerHeight = container.clientHeight;
      const viewportHeight = iframeHeight || 600;
      
      // Calculate zoom to fit height with some margin (90%)
      const fitZoom = Math.floor((containerHeight * 0.9 / viewportHeight) * 100);
      
      setZoom(Math.max(10, Math.min(fitZoom, 1000)));
      
      // Center the canvas
      setPanX(0);
      setPanY(0);
    }
  }, [iframeHeight, setZoom]);

  const handleAutofit = useCallback(() => {
    // Autofit - fits all three viewports horizontally with 32px gaps
    const container = canvasContainerRef.current;
    if (container) {
      const containerWidth = container.clientWidth;
      
      const GAP = 32; // 32px gap padding
      const VIEWPORT_GAP = 32; // Gap between viewports
      
      // Calculate total width of all three viewports
      const desktopWidth = parseInt(viewportSizes.desktop.width);
      const tabletWidth = parseInt(viewportSizes.tablet.width);
      const mobileWidth = parseInt(viewportSizes.mobile.width);
      
      const totalViewportWidth = desktopWidth + tabletWidth + mobileWidth + (VIEWPORT_GAP * 2);
      
      // Calculate zoom to fit all three viewports with padding
      const availableWidth = containerWidth - (GAP * 2);
      const fitZoom = Math.floor((availableWidth / totalViewportWidth) * 100);
      setZoom(Math.max(10, Math.min(fitZoom, 1000)));
      
      // Center horizontally, show top of iframes
      setPanX(0);
      setPanY(0);
      
      // Reset native scroll if any
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
  }, [setZoom]);

  // Keep refs in sync with state
  useEffect(() => {
    panXRef.current = panX;
    panYRef.current = panY;
    zoomRef.current = zoom;
  }, [panX, panY, zoom]);

  // Sync iframeRef with the currently active viewport
  useEffect(() => {
    if (viewportMode === 'desktop' && desktopIframeRef.current) {
      iframeRef.current = desktopIframeRef.current;
    } else if (viewportMode === 'tablet' && tabletIframeRef.current) {
      iframeRef.current = tabletIframeRef.current;
    } else if (viewportMode === 'mobile' && mobileIframeRef.current) {
      iframeRef.current = mobileIframeRef.current;
    }
    
    // Update the editor store's active breakpoint when viewport changes
    useEditorStore.getState().setActiveBreakpoint(viewportMode);
  }, [viewportMode]);

  // Autofit on initial load (default mode)
  useEffect(() => {
    if (iframeReady && canvasContainerRef.current) {
      // Delay slightly to ensure container has proper dimensions
      const timer = setTimeout(() => {
        handleAutofit();
      }, 100);
      
      return () => clearTimeout(timer);
    }
  }, [iframeReady, currentPageId, viewportMode, handleAutofit]);

  // Spacebar key handler for pan mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Check if user is typing in an input
        const target = e.target as HTMLElement;
        const isInputFocused = target.tagName === 'INPUT' ||
                               target.tagName === 'TEXTAREA' ||
                               target.isContentEditable;
        
        if (!isInputFocused) {
          setSpacePressed(true);
          e.preventDefault();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Pan/drag handlers with Framer-style transform
  useEffect(() => {
    const container = canvasContainerRef.current;
    const iframe = iframeRef.current;
    if (!container) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Only block panning if clicking ON the iframe element itself
      const isClickOnIframe = target.tagName === 'IFRAME';
      
      // Pan with spacebar + left click, middle mouse button, or direct click
      const isSpacebarPan = e.button === 0 && spacePressed;
      const isMiddleClick = e.button === 1;
      const isDirectPan = e.button === 0 && !spacePressed && !isClickOnIframe;

      const canPan = isSpacebarPan || isMiddleClick || isDirectPan;

      if (canPan) {
        isDragging = true;
        setIsPanning(true);
        startX = e.clientX;
        startY = e.clientY;
        // Use refs to get current values, avoiding stale closure
        startPanX = panXRef.current;
        startPanY = panYRef.current;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      setPanX(startPanX + deltaX);
      setPanY(startPanY + deltaY);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        setIsPanning(false);
      }
    };

    // Single event listener on container - no capture phase
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [spacePressed]); // Only spacePressed in dependencies - no panX/panY!

  // Scroll-to-pan handler (Framer-style: scroll without Ctrl pans the canvas)
  useEffect(() => {
    const container = canvasContainerRef.current;
    const desktopIframe = desktopIframeRef.current;
    const tabletIframe = tabletIframeRef.current;
    const mobileIframe = mobileIframeRef.current;
    if (!container) return;

    const handleScroll = (e: WheelEvent) => {
      // Only pan with scroll when Ctrl/Cmd is NOT pressed (zooming takes priority)
      if (e.ctrlKey || e.metaKey) {
        return; // Let zoom handler handle this
      }

      // Check if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' ||
                             target.tagName === 'TEXTAREA' ||
                             target.isContentEditable;

      if (isInputFocused) {
        return;
      }

      e.preventDefault();

      // Get current pan values from refs
      const currentPanX = panXRef.current;
      const currentPanY = panYRef.current;

      // Pan based on scroll delta
      // Negative because scrolling down should move content up (pan down)
      const deltaX = e.deltaX;
      const deltaY = e.deltaY;

      setPanX(currentPanX - deltaX);
      setPanY(currentPanY - deltaY);
    };

    // Add to container
    container.addEventListener('wheel', handleScroll, { passive: false });

    // Function to attach listener to iframe when it's ready
    const attachToIframe = (iframe: HTMLIFrameElement | null) => {
      if (!iframe) return;
      
      // Try to attach immediately if contentDocument is available
      if (iframe.contentDocument) {
        iframe.contentDocument.addEventListener('wheel', handleScroll, { passive: false });
      }
      
      // Also set up a listener for when the iframe loads
      const onLoad = () => {
        if (iframe.contentDocument) {
          iframe.contentDocument.addEventListener('wheel', handleScroll, { passive: false });
        }
      };
      iframe.addEventListener('load', onLoad);
      
      return () => {
        iframe.removeEventListener('load', onLoad);
      };
    };

    const cleanupDesktop = attachToIframe(desktopIframe);
    const cleanupTablet = attachToIframe(tabletIframe);
    const cleanupMobile = attachToIframe(mobileIframe);

    return () => {
      container.removeEventListener('wheel', handleScroll);
      if (desktopIframe?.contentDocument) {
        desktopIframe.contentDocument.removeEventListener('wheel', handleScroll);
      }
      if (tabletIframe?.contentDocument) {
        tabletIframe.contentDocument.removeEventListener('wheel', handleScroll);
      }
      if (mobileIframe?.contentDocument) {
        mobileIframe.contentDocument.removeEventListener('wheel', handleScroll);
      }
      cleanupDesktop?.();
      cleanupTablet?.();
      cleanupMobile?.();
    };
  }, []);

  // Zoom with mouse wheel - zoom towards cursor (Framer-style)
  // Supports both regular Ctrl+Scroll and trackpad pinch
  useEffect(() => {
    const container = canvasContainerRef.current;
    const desktopIframe = desktopIframeRef.current;
    const tabletIframe = tabletIframeRef.current;
    const mobileIframe = mobileIframeRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Only zoom when Ctrl (Windows/Linux) or Cmd (Mac) is pressed
      // Trackpad pinch gestures automatically set ctrlKey=true
      if (!(e.ctrlKey || e.metaKey)) {
        return;
      }

      // Check if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' ||
                             target.tagName === 'TEXTAREA' ||
                             target.isContentEditable;

      if (isInputFocused) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Calculate delta
      let deltaY = e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        deltaY *= 16;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        deltaY *= 100;
      }

      // Adjust sensitivity for trackpad pinch (which tends to have smaller deltaY values)
      // Trackpad pinch usually has deltaMode = 0 (pixels) and smaller absolute values
      // Reduced sensitivity to match Framer's gradual zoom feel
      const sensitivity = Math.abs(deltaY) < 50 ? 0.3 : 0.15;
      
      // Get current zoom from ref to avoid stale closure
      const currentZoom = zoomRef.current;
      const currentPanX = panXRef.current;
      const currentPanY = panYRef.current;
      
      // Calculate new zoom (inverted so scroll up = zoom in)
      const zoomDelta = -deltaY * sensitivity;
      const newZoom = Math.max(10, Math.min(1000, currentZoom + zoomDelta));

      // Get cursor position relative to container
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      // Calculate zoom ratio
      const zoomRatio = newZoom / currentZoom;

      // Zoom-to-cursor calculation with transform-origin: 0 0
      // The point under the cursor should stay fixed
      // Formula: newPan = cursor - (cursor - oldPan) * zoomRatio
      const newPanX = cursorX - (cursorX - currentPanX) * zoomRatio;
      const newPanY = cursorY - (cursorY - currentPanY) * zoomRatio;

      // Round zoom to whole numbers for clean display
      setZoom(Math.round(newZoom));
      setPanX(newPanX);
      setPanY(newPanY);
    };

    // Attach to both container and window for comprehensive coverage
    container.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('wheel', handleWheel, { passive: false });

    // Function to attach listener to iframe when it's ready
    const attachToIframe = (iframe: HTMLIFrameElement | null) => {
      if (!iframe) return;
      
      // Try to attach immediately if contentDocument is available
      if (iframe.contentDocument) {
        iframe.contentDocument.addEventListener('wheel', handleWheel, { passive: false });
      }
      
      // Also set up a listener for when the iframe loads
      const onLoad = () => {
        if (iframe.contentDocument) {
          iframe.contentDocument.addEventListener('wheel', handleWheel, { passive: false });
        }
      };
      iframe.addEventListener('load', onLoad);
      
      return () => {
        iframe.removeEventListener('load', onLoad);
      };
    };

    const cleanupDesktop = attachToIframe(desktopIframe);
    const cleanupTablet = attachToIframe(tabletIframe);
    const cleanupMobile = attachToIframe(mobileIframe);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      window.removeEventListener('wheel', handleWheel);
      if (desktopIframe?.contentDocument) {
        desktopIframe.contentDocument.removeEventListener('wheel', handleWheel);
      }
      if (tabletIframe?.contentDocument) {
        tabletIframe.contentDocument.removeEventListener('wheel', handleWheel);
      }
      if (mobileIframe?.contentDocument) {
        mobileIframe.contentDocument.removeEventListener('wheel', handleWheel);
      }
      cleanupDesktop?.();
      cleanupTablet?.();
      cleanupMobile?.();
    };
  }, []);

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Top Bar */}
      <div className="grid grid-cols-3 items-center p-4 border-b bg-background">
        {/* Page Selector or Back to Page Button */}
        {editingComponentId ? (
          <Button
            variant="purple"
            size="sm"
            onClick={handleExitComponentEditMode}
            className="gap-1 w-fit"
          >
            <Icon name="arrowLeft" />
            Back to {returnToPage ? returnToPage.name : 'Homepage'}
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            <Popover open={pagePopoverOpen} onOpenChange={setPagePopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="input"
                  size="sm"
                  role="combobox"
                  aria-expanded={pagePopoverOpen}
                  className="w-40 justify-between"
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <Icon name={currentPageIcon} className="size-3 opacity-50 shrink-0" />
                    <span className="truncate">
                      {currentPageName}
                    </span>
                  </div>
                  <div className="shrink-0">
                    <Icon name="chevronCombo" className="!size-2.5 shrink-0 opacity-50" />
                  </div>
                </Button>
              </PopoverTrigger>

              <PopoverContent className="w-auto min-w-60 max-w-96 p-1" align="start">
                <div className="max-h-[400px] overflow-y-auto">
                  {/* Regular pages tree */}
                  {pageTree.length > 0 && pageTree.map(node => renderPageTreeNode(node, 0))}

                  {/* Separator before error pages */}
                  <Separator className="my-1" />

                  {/* Virtual "Error pages" folder */}
                  {errorPagesNode && renderPageTreeNode(errorPagesNode, 0)}

                  {/* Empty state - only show if no pages at all */}
                  {pageTree.length === 0 && !errorPagesNode && (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No pages found
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Collection item selector for dynamic pages */}
            {currentPage?.is_dynamic && collectionId && (
              <Select
                value={currentPageCollectionItemId || ''}
                onValueChange={setCurrentPageCollectionItemId}
                disabled={isLoadingItems || collectionItems.length === 0}
              >
                <SelectTrigger className="" size="sm">
                  {isLoadingItems ? (
                    <Spinner className="size-3" />
                  ) : (
                    <Icon name="database" className="size-3" />
                  )}
                </SelectTrigger>

                <SelectContent>
                  {collectionItems.length > 0 ? (
                    collectionItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))
                  ) : (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No items available
                    </div>
                  )}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {/* Zoom Controls */}
        <div className="flex justify-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="input" size="sm">
                {zoom}%
                <div>
                  <Icon name="chevronCombo" className="!size-2.5 opacity-50" />
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={handleZoomIn}>
                Zoom in
                <DropdownMenuShortcut>⌘+</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleZoomOut}>
                Zoom out
                <DropdownMenuShortcut>⌘-</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleZoomTo100}>
                Zoom to 100%
                <DropdownMenuShortcut>⌘0</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleZoomToFit}>
                Zoom to Fit
                <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleAutofit}>
                Autofit
                <DropdownMenuShortcut>⌘2</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        </div>

        {/* Undo/Redo Buttons */}
        <div className="flex justify-end gap-0">
          <Button size="sm" variant="ghost">
            <Icon name="undo" />
          </Button>
          <Button size="sm" variant="ghost">
            <Icon name="redo" />
          </Button>
        </div>
      </div>

      {/* Canvas Area */}
      <div
        ref={canvasContainerRef}
        className={cn(
          'flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-950/80 relative',
          spacePressed && 'cursor-grab',
          isPanning && 'cursor-grabbing',
          !spacePressed && !isPanning && 'cursor-grab'
        )}
        data-canvas-container
      >
        {/* Transform wrapper for Framer-style zoom/pan */}
        <div
          ref={transformLayerRef}
          className={cn(
            'absolute inset-0 flex items-start justify-center p-8 gap-8',
            !isPanning && 'transition-transform duration-200 ease-out',
            !spacePressed && !isPanning && 'cursor-grab',
            isPanning && 'cursor-grabbing'
          )}
          style={{
            transform: `translate(${panX}px, ${panY}px) scale(${zoom / 100})`,
            transformOrigin: '0 0',
            willChange: isPanning ? 'transform' : 'auto',
          }}
        >
          {/* Desktop Preview */}
          <div 
            className="flex flex-col gap-3"
            onClick={() => setViewportMode('desktop')}
          >
            <div className="text-xs font-medium text-neutral-500 px-2">Desktop</div>
            <div
              className={cn(
                'bg-white shadow-xl overflow-hidden cursor-pointer',
                viewportMode === 'desktop' && 'ring-2 ring-blue-500'
              )}
              style={{
                width: viewportSizes.desktop.width,
                minHeight: iframeHeight ? `${iframeHeight}px` : '600px',
              }}
            >
              {layers.length > 0 ? (
                <iframe
                  ref={desktopIframeRef}
                  src="/canvas.html"
                  className="w-full border-0"
                  style={{
                    height: iframeHeight ? `${iframeHeight}px` : '600px',
                    pointerEvents: isPanning ? 'none' : 'auto',
                  }}
                  title="Desktop Preview"
                />
              ) : null}
            </div>
          </div>

          {/* Tablet Preview */}
          <div 
            className="flex flex-col gap-3"
            onClick={() => setViewportMode('tablet')}
          >
            <div className="text-xs font-medium text-neutral-500 px-2">Tablet</div>
            <div
              className={cn(
                'bg-white shadow-xl overflow-hidden cursor-pointer',
                viewportMode === 'tablet' && 'ring-2 ring-blue-500'
              )}
              style={{
                width: viewportSizes.tablet.width,
                minHeight: iframeHeight ? `${iframeHeight}px` : '600px',
              }}
            >
              {layers.length > 0 ? (
                <iframe
                  ref={tabletIframeRef}
                  src="/canvas.html"
                  className="w-full border-0"
                  style={{
                    height: iframeHeight ? `${iframeHeight}px` : '600px',
                    pointerEvents: isPanning ? 'none' : 'auto',
                  }}
                  title="Tablet Preview"
                />
              ) : null}
            </div>
          </div>

          {/* Mobile Preview */}
          <div 
            className="flex flex-col gap-3"
            onClick={() => setViewportMode('mobile')}
          >
            <div className="text-xs font-medium text-neutral-500 px-2">Mobile</div>
            <div
              className={cn(
                'bg-white shadow-xl overflow-hidden cursor-pointer',
                viewportMode === 'mobile' && 'ring-2 ring-blue-500'
              )}
              style={{
                width: viewportSizes.mobile.width,
                minHeight: iframeHeight ? `${iframeHeight}px` : '600px',
              }}
            >
              {layers.length > 0 ? (
                <iframe
                  ref={mobileIframeRef}
                  src="/canvas.html"
                  className="w-full border-0"
                  style={{
                    height: iframeHeight ? `${iframeHeight}px` : '600px',
                    pointerEvents: isPanning ? 'none' : 'auto',
                  }}
                  title="Mobile Preview"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default CenterCanvas;
