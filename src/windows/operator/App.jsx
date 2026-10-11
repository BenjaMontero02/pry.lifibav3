import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import useDiagnostics from "./hooks/useDiagnostics";
import usePhotos from "./hooks/usePhotos";
import useScanPlayer from "./hooks/useScanPlayer";
import useSourcePathConfig from "./hooks/useSourcePathConfig";
import useIndexSettings from "./hooks/useIndexSettings";
import DiagnosticsView from "./views/DiagnosticsView";
import OverviewView from "./views/OverviewView";
import PhotosView from "./views/PhotosView";
import ScanPlayerView from "./views/ScanPlayerView";
import SettingsView from "./views/SettingsView";
import { getDesktopApi } from "../../shared/desktopApi";

const NAV_ITEMS = [
  { id: "overview", label: "Resumen" },
  { id: "photos", label: "Fotos" },
  { id: "scan-player", label: "Escanear" },
  { id: "diagnostics", label: "Diagnostico" },
  { id: "settings", label: "Ajustes" }
];

export default function App() {
  const desktopApi = useMemo(() => getDesktopApi(), []);
  const [activeView, setActiveView] = useState("settings");
  const initialViewResolvedRef = useRef(false);

  const sourceConfig = useSourcePathConfig(desktopApi);
  const indexSettings = useIndexSettings(desktopApi, activeView);
  const scan = useScanPlayer({ desktopApi, activeView });
  const diagnostics = useDiagnostics({ desktopApi, activeView });
  const photos = usePhotos({
    desktopApi,
    activeView,
    persistedPath: sourceConfig.persistedPath,
    onIndexCleared: scan.clearMatches,
    onIndexRebuilt: scan.clearMatches
  });

  const { clearMatches } = scan;
  useEffect(() => {
    // Otra carpeta de fotos: los resultados del escaneo anterior son de otro catalogo.
    clearMatches();
  }, [clearMatches, sourceConfig.persistedPath]);

  useEffect(() => {
    // Arranque: con carpeta guardada se entra directo a Escanear. Solo se decide
    // una vez, para no pisar la navegacion del operador.
    if (initialViewResolvedRef.current || sourceConfig.loading) {
      return;
    }
    initialViewResolvedRef.current = true;
    // Con la carpeta guardada borrada o movida, el operador tiene que pasar por
    // Ajustes antes de poder escanear.
    if (sourceConfig.persistedPathValid) {
      setActiveView("scan-player");
    }
  }, [sourceConfig.loading, sourceConfig.persistedPathValid]);

  return (
    <main className="operator-shell">
      <div className="operator-layout">
        <Sidebar
          brand="LifiBA"
          items={NAV_ITEMS}
          activeItemId={activeView}
          onSelectItem={setActiveView}
        />

        <section className="operator-content">
          {activeView === "settings" ? (
            <SettingsView
              sourcePath={sourceConfig.sourcePath}
              loading={sourceConfig.loading}
              saving={sourceConfig.saving}
              picking={sourceConfig.picking}
              canSave={sourceConfig.canSave}
              hasChanges={sourceConfig.hasChanges}
              status={sourceConfig.status}
              statusClassName={sourceConfig.statusClassName}
              onSourcePathChange={sourceConfig.setSourcePath}
              onPickFolder={sourceConfig.handlePickFolder}
              onSave={sourceConfig.handleSave}
              faceSizePx={indexSettings.faceSizePx}
              faceDetScore={indexSettings.faceDetScore}
              minFaceQuality={indexSettings.minFaceQuality}
              detectionMode={indexSettings.detectionMode}
              indexQuality={indexSettings.indexQuality}
              indexLoading={indexSettings.loading}
              indexSaving={indexSettings.saving}
              indexStatus={indexSettings.status}
              onFaceSizePxChange={indexSettings.setFaceSizePx}
              onFaceDetScoreChange={indexSettings.setFaceDetScore}
              onMinFaceQualityChange={indexSettings.setMinFaceQuality}
              onDetectionModeChange={indexSettings.setDetectionMode}
              onIndexSettingsSave={indexSettings.handleSave}
            />
          ) : activeView === "photos" ? (
            <PhotosView
              photos={photos.photos}
              photosMeta={photos.photosMeta}
              photosPath={photos.photosPath}
              photosLoading={photos.photosLoading}
              photosError={photos.photosError}
              photosSearchDraft={photos.photosSearchDraft}
              photosQuery={photos.photosQuery}
              indexingPhotos={photos.indexingPhotos}
              indexingProgressPercent={photos.indexingProgressPercent}
              indexingProgressLabel={photos.indexingProgressLabel}
              indexingMessage={photos.indexingMessage}
              clearingIndex={photos.clearingIndex}
              currentIndexSummary={photos.currentIndexSummary}
              hasMorePhotos={photos.hasMorePhotos}
              photosScrollRef={photos.photosScrollRef}
              onIndexPhotos={photos.handleIndexPhotos}
              onReindexAll={photos.handleReindexAll}
              onReloadPhotos={photos.handleReloadPhotos}
              onClearIndex={photos.handleClearIndex}
              onPhotosSearchSubmit={photos.handlePhotosSearchSubmit}
              onPhotosSearchDraftChange={photos.setPhotosSearchDraft}
              onClearPhotosSearch={photos.handleClearPhotosSearch}
              onPhotosScroll={photos.handlePhotosScroll}
              onShowMorePhotos={photos.handleShowMorePhotos}
              onOpenPhoto={photos.handleOpenPhoto}
            />
          ) : activeView === "scan-player" ? (
            <ScanPlayerView
              availableCameras={scan.availableCameras}
              selectedCameraId={scan.selectedCameraId}
              scanThreshold={scan.scanThreshold}
              scanQueryExpansion={scan.scanQueryExpansion}
              indexingPhotos={photos.indexingPhotos}
              scanCameraStarting={scan.scanCameraStarting}
              scanCameraActive={scan.scanCameraActive}
              scanVideoReady={scan.scanVideoReady}
              scanInProgress={scan.scanInProgress}
              scanMatches={scan.scanMatches}
              selectedMatchKeys={scan.selectedMatchKeys}
              selectedMatches={scan.selectedMatches}
              sendingPreview={scan.sendingPreview}
              printingPhotos={scan.printingPhotos}
              clearingPlayer={scan.clearingPlayer}
              scanStatus={scan.scanStatus}
              jumpToMatchValue={scan.jumpToMatchValue}
              jumpToMatchFeedback={scan.jumpToMatchFeedback}
              scanVideoRef={scan.scanVideoRef}
              scanCanvasRef={scan.scanCanvasRef}
              matchCardRefs={scan.matchCardRefs}
              onSelectedCameraIdChange={scan.setSelectedCameraId}
              onScanThresholdChange={scan.setScanThreshold}
              onScanQueryExpansionChange={scan.setScanQueryExpansion}
              onToggleCamera={scan.handleToggleScanCamera}
              onCaptureAndSearch={scan.handleCaptureAndSearch}
              onVideoLoadedMetadata={scan.handleScanVideoLoadedMetadata}
              onJumpToMatchValueChange={scan.setJumpToMatchValue}
              onJumpToMatch={scan.handleJumpToMatch}
              onSendPreview={scan.handleSendPreview}
              onPrintSelected={scan.handlePrintSelected}
              onNewPlayer={scan.handleNewPlayer}
              onSelectAllMatches={scan.handleSelectAllMatches}
              onClearMatchSelection={scan.handleClearMatchSelection}
              onToggleMatchSelection={scan.toggleMatchSelection}
            />
          ) : activeView === "diagnostics" ? (
            <DiagnosticsView diagnostics={diagnostics} />
          ) : (
            <OverviewView />
          )}
        </section>
      </div>
    </main>
  );
}
