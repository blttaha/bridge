package com.tahablt.bridge;

import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

public class QsMonitorsOnTileService extends TileService {
    protected int getSlotIndex() { return -1; }
    protected String getActionKey() { return "monitors_on"; }
    protected String getBaseTitle() { return "Ekranı Aç"; }
    protected int getIconRes() { return R.drawable.qs_icon_monitors_on; }

    @Override
    public void onTileAdded() {
        super.onTileAdded();
        refreshTile();
    }

    @Override
    public void onStartListening() {
        super.onStartListening();
        refreshTile();
    }

    protected void refreshTile() {
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setState(Tile.STATE_INACTIVE);
            String devName = MainActivity.getShortDeviceNameForSlot(this, getSlotIndex());
            if (devName != null && !devName.isEmpty()) {
                tile.setLabel(getBaseTitle() + " (" + devName + ")");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    tile.setSubtitle(devName);
                }
            } else {
                tile.setLabel(getBaseTitle());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    tile.setSubtitle("");
                }
            }
            try {
                tile.setIcon(Icon.createWithResource(this, getIconRes()));
            } catch (Exception ignored) {}
            tile.updateTile();
        }
    }

    @Override
    public void onClick() {
        MainActivity.executeQuickDeviceActionForSlot(this, getActionKey(), getSlotIndex());
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setState(Tile.STATE_ACTIVE);
            tile.updateTile();
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                refreshTile();
            }, 650);
        }
    }
}
