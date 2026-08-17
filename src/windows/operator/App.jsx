import { useMemo, useState } from "react";
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

  const sourceConfig = useSourcePathConfig(desktopApi);
  const indexSettings = useIndexSettings(desktopApi);
  const scan = useScanPlayer({ desktopApi, activeView });
  const diagnostics = useDiagnostics({ desktopApi, activeView });
  const photos = usePhotos({
    desktopApi,
    activeView,
    persistedPath: sourceConfig.persistedPath,
    onIndexCleared: scan.clearMatches
  });

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
              indexLoading={indexSettings.loading}
              indexSaving={indexSettings.saving}
              indexStatus={indexSettings.status}
              onFaceSizePxChange={indexSettings.setFaceSizePx}
              onFaceDetScoreChange={indexSettings.setFaceDetScore}
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
              scanCameraStarting={scan.scanCameraStarting}
              scanCameraActive={scan.scanCameraActive}
              scanVideoReady={scan.scanVideoReady}
              scanInProgress={scan.scanInProgress}
              scanMatches={scan.scanMatches}
              selectedMatchKeys={scan.selectedMatchKeys}
              selectedMatches={scan.selectedMatches}
              sendingPreview={scan.sendingPreview}
              scanStatus={scan.scanStatus}
              jumpToMatchValue={scan.jumpToMatchValue}
              jumpToMatchFeedback={scan.jumpToMatchFeedback}
              scanVideoRef={scan.scanVideoRef}
              scanCanvasRef={scan.scanCanvasRef}
              matchCardRefs={scan.matchCardRefs}
              onSelectedCameraIdChange={scan.setSelectedCameraId}
              onScanThresholdChange={scan.setScanThreshold}
              onToggleCamera={scan.handleToggleScanCamera}
              onCaptureAndSearch={scan.handleCaptureAndSearch}
              onVideoLoadedMetadata={scan.handleScanVideoLoadedMetadata}
              onJumpToMatchValueChange={scan.setJumpToMatchValue}
              onJumpToMatch={scan.handleJumpToMatch}
              onSendPreview={scan.handleSendPreview}
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
