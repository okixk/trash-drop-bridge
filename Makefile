UUID := trash-drop-bridge@oki
DIST := dist
BUNDLE := $(DIST)/$(UUID).shell-extension.zip
SCHEMA := schemas/org.gnome.shell.extensions.trash-drop-bridge.gschema.xml

.PHONY: all check install clean

all: check
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) --schema=$(SCHEMA) \
		--extra-source=LICENSE --extra-source=README.md .

check:
	glib-compile-schemas --strict --dry-run schemas
	python3 -m json.tool metadata.json >/dev/null

install: all
	gnome-extensions install --force $(BUNDLE)

clean:
	rm -rf $(DIST)
