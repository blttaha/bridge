package com.tahablt.bridge;

public class QsMonitorsOffTileService extends QsMonitorsOnTileService {
    @Override protected String getActionKey() { return "monitors_off"; }
    @Override protected String getBaseTitle() { return "Ekranı Karart"; }
    @Override protected int getIconRes() { return R.drawable.qs_icon_monitors_off; }
}
